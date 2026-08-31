/**
 * A person's standing instructions: keeping them, and guarding them.
 *
 * THIS FILE HAS TWO HALVES, AND THEY ARE SEPARABLE ON PURPOSE. The half below is the one a person
 * touches: create, list, change, remove, switch off. It is asked questions through a Bot, so every
 * refusal is a sentence a model can act on, every statement is guarded by the owner, and the owner is
 * never taken from an argument a model supplied. Its failures are one person's failures — a bad cron,
 * a channel they are not in — and none of them are about two things happening at once.
 *
 * The other half is the sweep's, and it starts at the marked boundary further down: the ledger read
 * on a clock (which routines are due, advancing the next run, opening and closing a run row).
 * Nothing there is asked a question by a person, and everything there is about concurrency — several
 * replicas reading the same due row in the same second. That is why the halves are worth telling
 * apart: only the second one has anything to do with concurrency, and only the second one needs to be
 * reasoned about as a race.
 *
 * NO CLAIM OR LEASE MACHINERY, EVER. Firing mechanics belong to the shared `work_items` queue in
 * `server/src/work/queue.ts`, which already owns `for update skip locked`, leases on the database's
 * clock, and an attempt count. A second lease grown on the routines table — a `claimed_by`, a
 * `locked_until` — is exactly the duplicated firing mechanism #235 exists to prevent: two half-right
 * implementations of the same hard thing, one of which nobody tests.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  routineRuns,
  routines,
  routineWorkerHeartbeats,
} from "../db/schema";
import { describeCron, nextOccurrence, ScheduleRefusedError } from "./schedule";

export class RoutineNotFoundError extends Error {
  constructor(message = "That routine does not exist.") {
    super(message);
    this.name = "RoutineNotFoundError";
  }
}

/** The floor, the cap, a bad zone, a channel that is not the caller's. Carries the sentence verbatim. */
export class RoutineRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineRefusedError";
  }
}

/** A second firing is refused while the first still owns this routine's thread. */
export class RoutineOverlapError extends Error {
  constructor(message = "That routine is already running.") {
    super(message);
    this.name = "RoutineOverlapError";
  }
}

/** A person may keep this many routines switched on. A constant with a reason, not a setting. */
export const MAX_ENABLED_ROUTINES = 20;
/** Same code-point cap discipline as channel activity. */
export const MAX_INSTRUCTION_CODE_POINTS = 2000;
/** Capped like audit payloads, because a failure is not a promise about length. */
export const MAX_RUN_ERROR = 400;
export const ROUTINE_OVERLAP_POLICIES = [
  "skip",
  "queue_one",
  "allow_overlap",
] as const;
export type SupportedRoutineOverlapPolicy =
  (typeof ROUTINE_OVERLAP_POLICIES)[number];
export type RoutineOverlapPolicy = SupportedRoutineOverlapPolicy;
/**
 * How far back the failure count looks.
 *
 * Twice what the fatigue rule can act on, so the answer is never truncated where it matters, and
 * bounded because an unbounded read of a routine's whole history is the wrong shape for something
 * called on every failed firing, for ever: a routine that has failed nightly for a year would make
 * the count get slower exactly as the routine got worse.
 */
const FAILURE_SCAN_LIMIT = 20;

const NO_SHARED_CHANNEL =
  "I can only post into a channel you and I are both in.";
const NO_CHANNEL_AT_ALL =
  "We have no channel for me to post into. Start one and ask again.";
const INSTRUCTION_EMPTY = "A routine needs an instruction to carry out.";
const INSTRUCTION_TOO_LONG = `An instruction can be at most ${MAX_INSTRUCTION_CODE_POINTS} characters.`;
const TOO_MANY_ENABLED = `You already have ${MAX_ENABLED_ROUTINES} routines switched on. Switch one off before adding another.`;
/** How many names an ambiguity refusal reads out before it gives up and says "and others". */
const MAX_NAMED_CHANNELS = 5;

export type RoutineRunOutcome = "succeeded" | "failed" | "skipped";
export type RoutineWorkerHeartbeatStatus = "succeeded" | "failed";

export type Routine = {
  id: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  instruction: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  overlapPolicy: RoutineOverlapPolicy;
  nextRunAt: Date;
  lastRunAt: Date | null;
  createdAt: Date;
};

/** One row of the routines page: everything it draws, and nothing it would have to parse. */
export type RoutineSummary = {
  id: string;
  agentId: string;
  instruction: string;
  /**
   * The schedule in words — "Weekdays at 09:00" — for the shapes `describeCron` recognizes, and
   * the raw five-field expression for everything else. Prose where prose is possible; never a
   * value the client is expected to parse.
   *
   * Rendering cron exhaustively in English needs a real cron-description library, which this does
   * not carry. So a consumer must treat this as opaque display text: show it, never parse it, and
   * never compute a time from it. The authoritative next firing is `nextRunAt`, which the store
   * and the sweep both derive from the expression itself.
   */
  schedule: string;
  /** The authoritative five-field expression, exposed only to the authenticated edit form. */
  cron: string;
  timezone: string;
  enabled: boolean;
  overlapPolicy?: RoutineOverlapPolicy;
  nextRunAt: Date;
  channelId: string;
  /** The target channel's name, or null when the row is gone entirely rather than soft-deleted. */
  channelName: string | null;
  /** Whether the target channel was deleted. A broken routine is shown, not hidden. */
  channelDeleted: boolean;
  /** The most recent firing, or null when it has never fired. */
  lastRun: { status: RoutineRunOutcome | null; finishedAt: Date | null } | null;
};

export type RoutineRunHistory = {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: RoutineRunOutcome | null;
  durationMs: number | null;
  /** A deliberately coarse sentence; the stored provider error is never returned to the browser. */
  errorSummary: string | null;
};

export type RoutineInput = {
  ownerUserId: string;
  agentId: string;
  channelId?: string;
  instruction: string;
  cron: string;
  timezone?: string;
  overlapPolicy?: SupportedRoutineOverlapPolicy;
};

/**
 * One firing, and everything running it headlessly needs — the runner's read, and nobody else's.
 *
 * The owner comes back because the runner acts AS the owner: the channel it posts into, the thread
 * it continues and the grants the turn resolves are all that person's, and a runner that had to be
 * told whose they were would be a runner that could be told the wrong answer.
 */
export type RoutineRunContext = {
  routineId: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  instruction: string;
  overlapPolicy: RoutineOverlapPolicy;
};

export type RoutinePatch = Partial<{
  agentId: string;
  instruction: string;
  cron: string;
  timezone: string;
  channelId: string;
  enabled: boolean;
  overlapPolicy: SupportedRoutineOverlapPolicy;
}>;

export type RoutineStore = {
  create(input: RoutineInput): Promise<Routine>;
  listFor(ownerUserId: string): Promise<RoutineSummary[]>;
  update(
    ownerUserId: string,
    id: string,
    patch: RoutinePatch,
  ): Promise<Routine>;
  remove(ownerUserId: string, id: string): Promise<void>;
  setEnabled(ownerUserId: string, id: string, enabled: boolean): Promise<void>;
  /** Owner-scoped history for the schedules page. */
  listRunsFor?(
    ownerUserId: string,
    id: string,
    limit: number,
  ): Promise<RoutineRunHistory[]>;
  /** Owner-scoped, overlap-safe opening for the explicit Run now action. */
  insertManualRun?(ownerUserId: string, id: string): Promise<{ runId: string }>;

  /** The latest completed scheduler pass, shared by every API and worker replica. */
  readWorkerHeartbeat(): Promise<{
    status: RoutineWorkerHeartbeatStatus;
    heartbeatAt: Date;
    /** The same database clock used to write heartbeatAt, read in the same statement. */
    observedAt: Date;
  } | null>;
  /** Record only the outcome; the database supplies the authoritative timestamp. */
  recordWorkerHeartbeat(status: RoutineWorkerHeartbeatStatus): Promise<void>;

  /* The sweep's half. Deliberately not owner-scoped — see the boundary comment below. */

  /** Enabled routines whose next run has arrived, oldest due first. */
  dueRoutines(limit: number): Promise<{ id: string; nextRunAt: Date }[]>;
  /**
   * Compare-and-set the clock forward. False means another sweep got there first.
   *
   * The CAS always compares against `from`, the stamp the caller read. `computeFrom` is for the
   * stale-backlog case: a routine whose stamp is a month behind used to be stepped one occurrence
   * per pass — a fifteen-minute routine idle a month stayed silent another fortnight while its
   * clock caught up — so the sweep passes `now` here and one advance makes the clock current.
   */
  advanceNextRun(id: string, from: Date, computeFrom?: Date): Promise<boolean>;
  /** Open a scheduled run, or deterministically skip/reserve/deduplicate an overlap. */
  insertRun(
    routineId: string,
    firing?: {
      key: string;
      scheduledFor: Date;
      /** The original occurrence retained in the routine's durable queue-one slot. */
      queuedSourceKey?: string;
    },
  ): Promise<{
    runId: string;
    skipped?: boolean;
    queued?: boolean;
    duplicate?: boolean;
    obsolete?: boolean;
  }>;
  /** Queue-one reservations ready to become idempotent work items, oldest first. */
  queuedRoutines?(
    limit: number,
  ): Promise<{ id: string; firingKey: string; scheduledFor: Date }[]>;
  /**
   * The runner's read: an opened run row, joined to the routine it fires.
   *
   * Not owner-scoped, like everything else in this half — a run id is not something a person names,
   * it is something the queue hands back — and deliberately out of RoutineTools' reach: nothing a
   * model can call resolves a run id, so nothing a model can call gets an owner out of one. Null
   * means the routine was deleted between queueing and running, which takes its runs with it.
   */
  runContext(runId: string): Promise<RoutineRunContext | null>;
  /**
   * The sweep's read, like `dueRoutines` — not owner-scoped. A routine id here comes from a work
   * item's own payload, not from a person, so there is no owner to check it against. Answers exactly
   * what the consumer's re-read needs before firing: has the routine been deleted or switched off
   * since the offer. Null means deleted; otherwise `enabled` says the rest.
   */
  routineForFiring(
    id: string,
  ): Promise<{ id: string; enabled: boolean } | null>;
  /** Close a run row with its outcome, and the capped error when there was one. */
  finishRun(
    runId: string,
    status: RoutineRunOutcome,
    error?: string,
  ): Promise<void>;
  /**
   * Close every run row that has sat open (`status is null`) longer than `olderThanMs` as
   * "skipped", with the same reason on all of them. Returns how many rows it closed.
   *
   * The sweep's reaper, and deliberately NOT scoped to one routine or one firing: it exists for the
   * rows nothing else can reach — a server that died mid-turn after the queue item was already
   * finished on the 202, or a dispatch-failure close that itself failed. The age bound is what keeps
   * it away from live work: a run younger than the cutoff may be a turn some server is still
   * running, and closing that row would make the real `finishRun` a silent no-op. "skipped" rather
   * than "failed" so an infrastructure death is not counted by the fatigue rule as the routine's own
   * failure.
   */
  reapAbandonedRuns(olderThanMs: number, error: string): Promise<number>;
  /**
   * Switch a routine off because its own schedule refuses to advance, and record why.
   *
   * The sweep's off switch, not a person's, so it is not owner-scoped — like everything else in this
   * half, the id comes from the sweep's own read, not from a caller. A routine whose stored cron the
   * schedule module refuses (a row written before a validation existed, a hand-edited value) throws
   * out of `advanceNextRun` on every pass for ever: its clock never moves, it burns one of the
   * pass's due slots each time, and the owner sees a routine that silently stopped. Disabling it
   * ends that, and the finished "skipped" run row this writes is the announcement — the sweep has no
   * channel to speak in, and the run history is what `listFor` surfaces to the owner.
   */
  markUnschedulable(id: string, reason: string): Promise<void>;
  /** How many failures the routine has at the tail, for the fatigue rule to read. */
  consecutiveFailures(routineId: string): Promise<number>;
};

type RoutineRow = typeof routines.$inferSelect;

/** What drizzle hands the callback of `database.transaction`. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    agentId: row.agentId,
    channelId: row.channelId,
    instruction: row.instruction,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    overlapPolicy: row.overlapPolicy,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
  };
}

function validOverlapPolicy(
  policy: RoutineOverlapPolicy,
): SupportedRoutineOverlapPolicy {
  return policy;
}

/** Trim, then measure in code points like channel activity does — not in UTF-16 units. */
function validInstruction(instruction: string): string {
  const trimmed = instruction.trim();
  if (trimmed.length === 0) throw new RoutineRefusedError(INSTRUCTION_EMPTY);
  if (Array.from(trimmed).length > MAX_INSTRUCTION_CODE_POINTS) {
    throw new RoutineRefusedError(INSTRUCTION_TOO_LONG);
  }
  return trimmed;
}

/**
 * Convert an internal/provider failure into a sentence safe for a member-facing run history.
 *
 * Provider errors may contain request fragments, URLs or credential-adjacent details. The database
 * keeps the capped original for operators, while the schedules page gets only a small vocabulary of
 * actionable categories. Unknown errors stay unknown instead of becoming an accidental log viewer.
 */
export function safeRoutineRunError(error: string | null): string | null {
  if (!error) return null;
  const normalized = error.toLowerCase();
  if (
    normalized.includes("invalid_grant") ||
    normalized.includes("oauth") ||
    normalized.includes("authorization expired") ||
    (normalized.includes("google") && normalized.includes("authoriz"))
  ) {
    return "Google authorization needs to be reconnected.";
  }
  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("deadline")
  ) {
    return "The run timed out.";
  }
  if (normalized.includes("channel is gone")) {
    return "The target channel is unavailable.";
  }
  if (normalized.includes("already running")) {
    return "Skipped because the previous run was still active.";
  }
  if (normalized.includes("too long after the occurrence")) {
    return "The scheduled time was missed while the worker was unavailable.";
  }
  if (normalized.includes("switched off") || normalized.includes("disabled")) {
    return "The routine was paused before it could run.";
  }
  return "The run did not complete.";
}

/**
 * The schedule module owns both acceptance and the next occurrence, so its refusal sentence is the
 * one a person should read. It is carried through verbatim rather than reworded here: a model that
 * gets "Routines may run at most every 15 minutes" can propose a schedule that works, and a model
 * that gets "invalid cron" cannot.
 */
function nextRunFor(cron: string, timezone: string, after: Date): Date {
  try {
    return nextOccurrence(cron, timezone, after);
  } catch (error) {
    if (error instanceof ScheduleRefusedError) {
      throw new RoutineRefusedError(error.message);
    }
    throw error;
  }
}

/**
 * "A", "A, B", or five names and "and others" — a sentence, not a list a client renders.
 *
 * A name alone is not always enough to ask by: a real account turned up six channels all named
 * "General Assistant" with the same Bot, and a refusal built from names alone read "General
 * Assistant, General Assistant, … and others" — circular, because the person cannot answer it and
 * the model cannot map an answer back to a channelId. So every candidate whose name is shared by
 * another candidate gets its full id appended in parentheses; the id is the one thing the model can
 * pass back as `channelId` when names cannot tell two channels apart, and a person pasting it back
 * is ugly but functional. A candidate with a unique name stays bare, so the common case — and the
 * sentence's length — is unaffected by a collision elsewhere in the list.
 */
function nameThem(candidates: { id: string; name: string }[]): string {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
  }
  const labels = candidates.map((candidate) =>
    (counts.get(candidate.name) ?? 0) > 1
      ? `${candidate.name} (${candidate.id})`
      : candidate.name,
  );
  if (labels.length <= MAX_NAMED_CHANNELS) return labels.join(", ");
  return [...labels.slice(0, MAX_NAMED_CHANNELS), "and others"].join(", ");
}

export function createRoutineStore(database: Database): RoutineStore {
  /**
   * Apply one routine's overlap policy while opening an idempotent run row.
   *
   * The advisory lock is shared by scheduled and manual openings. It closes the race where a click
   * and a worker both decide against the same active set. `allow_overlap` admits every occurrence;
   * its turns still take the canonical channel's cross-replica single-writer lock in `run-turn.ts`,
   * so no two writers can corrupt one transcript.
   */
  async function openRun(
    handle: Transaction,
    routineId: string,
    overlap: "record-skip" | "refuse",
    firing?: {
      key: string;
      scheduledFor: Date;
      queuedSourceKey?: string;
    },
  ): Promise<{
    runId: string;
    skipped?: boolean;
    queued?: boolean;
    duplicate?: boolean;
    obsolete?: boolean;
  }> {
    await handle.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`routine-run-${routineId}`}))`,
    );

    const [routine] = await handle
      .select({
        enabled: routines.enabled,
        overlapPolicy: routines.overlapPolicy,
        queuedFiringKey: routines.queuedFiringKey,
      })
      .from(routines)
      .where(eq(routines.id, routineId))
      .limit(1);
    if (!routine) throw new RoutineNotFoundError();

    // The authenticated firing read happens before this transaction. Re-check under the same
    // per-routine lock used by pause, so a pause that committed first cannot be followed by a
    // queued or newly opened run from the stale read.
    if (firing && !routine.enabled) {
      return { runId: firing.key, obsolete: true };
    }

    if (firing) {
      const [sameFiring] = await handle
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .where(eq(routineRuns.firingKey, firing.key))
        .limit(1);
      if (sameFiring) {
        return { runId: sameFiring.id, duplicate: true };
      }
    }

    const open = await handle
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(
        and(eq(routineRuns.routineId, routineId), isNull(routineRuns.status)),
      )
      .limit(1);
    if (
      overlap === "refuse" &&
      routine.overlapPolicy !== "allow_overlap" &&
      (open.length > 0 || routine.queuedFiringKey !== null)
    ) {
      throw new RoutineOverlapError();
    }

    if (firing?.queuedSourceKey) {
      if (
        routine.overlapPolicy !== "queue_one" ||
        routine.queuedFiringKey !== firing.queuedSourceKey
      ) {
        return { runId: firing.key, obsolete: true };
      }
      // Manual openings refuse while the reservation exists, and later scheduled occurrences are
      // collapsed into it under this same lock. Seeing another active row is therefore a recovery
      // anomaly, not permission to create a second run.
      if (open.length > 0) {
        return { runId: firing.key, queued: true };
      }
      const runId = `routine_run_${crypto.randomUUID()}`;
      const [row] = await handle
        .insert(routineRuns)
        .values({ id: runId, routineId, firingKey: firing.key })
        .returning({ id: routineRuns.id });
      if (!row) throw new Error("inserting a routine run returned no row");
      await handle
        .update(routines)
        .set({
          queuedFiringKey: null,
          queuedScheduledFor: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(routines.id, routineId),
            eq(routines.queuedFiringKey, firing.queuedSourceKey),
          ),
        );
      return { runId: row.id };
    } else if (
      open.length > 0 &&
      firing &&
      routine.overlapPolicy !== "allow_overlap"
    ) {
      if (routine.overlapPolicy === "queue_one") {
        if (routine.queuedFiringKey === null) {
          await handle
            .update(routines)
            .set({
              queuedFiringKey: firing.key,
              queuedScheduledFor: firing.scheduledFor,
              updatedAt: sql`now()`,
            })
            .where(eq(routines.id, routineId));
          return { runId: firing.key, queued: true };
        }
        // One reservation already exists. This occurrence is intentionally collapsed, with a
        // finished ledger row so the owner can see that it did not become another deferred run.
      }
    } else if (
      firing &&
      routine.overlapPolicy === "queue_one" &&
      routine.queuedFiringKey !== null
    ) {
      // The deferred occurrence has priority even in the small gap between being offered and being
      // claimed. A newer scheduled occurrence cannot jump ahead of it.
    } else {
      const runId = `routine_run_${crypto.randomUUID()}`;
      const [row] = await handle
        .insert(routineRuns)
        .values({
          id: runId,
          routineId,
          ...(firing ? { firingKey: firing.key } : {}),
        })
        .returning({ id: routineRuns.id });
      if (!row) throw new Error("inserting a routine run returned no row");
      return { runId: row.id };
    }

    const runId = `routine_run_${crypto.randomUUID()}`;
    const [row] = await handle
      .insert(routineRuns)
      .values({
        id: runId,
        routineId,
        ...(firing ? { firingKey: firing.key } : {}),
        status: "skipped" as const,
        finishedAt: sql`now()`,
        error:
          routine.overlapPolicy === "queue_one"
            ? "one deferred run was already queued"
            : "another run was already running",
      })
      .returning({ id: routineRuns.id });
    if (!row) throw new Error("inserting a routine run returned no row");
    return { runId: row.id, skipped: true };
  }

  /**
   * Where the reply lands, decided here rather than at the tool boundary.
   *
   * Discovery confirmed the conversation's own channel is not reachable at the tool layer, so a model
   * asked to make a routine either names a channel or names nothing. Both are resolved against what
   * the owner and this agent actually share, which is the only check that stops a routine posting
   * one person's summary into another person's conversation.
   */
  async function resolveChannel(
    ownerUserId: string,
    agentId: string,
    channelId?: string,
  ): Promise<string> {
    if (channelId !== undefined) {
      // One query for all four conditions: the channel exists, it is not deleted, the owner is a
      // member, and this agent is in it. Any miss is the same refusal, because telling them apart
      // would tell a caller which channel ids exist.
      const rows = await database
        .select({ id: channels.id })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, ownerUserId),
          ),
        )
        .innerJoin(
          channelAgents,
          and(
            eq(channelAgents.channelId, channels.id),
            eq(channelAgents.agentId, agentId),
          ),
        )
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .limit(1);
      const found = rows[0];
      if (!found) throw new RoutineRefusedError(NO_SHARED_CHANNEL);
      return found.id;
    }

    // Six rows is enough to answer the question: one resolves, more than one refuses, and the
    // sentence names at most five before it says "and others".
    const candidates = await database
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, ownerUserId),
        ),
      )
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, channels.id),
          eq(channelAgents.agentId, agentId),
        ),
      )
      .where(isNull(channels.deletedAt))
      .orderBy(desc(channels.createdAt), desc(channels.id))
      .limit(MAX_NAMED_CHANNELS + 1);

    const only = candidates[0];
    if (!only) throw new RoutineRefusedError(NO_CHANNEL_AT_ALL);
    if (candidates.length > 1) {
      // Named, because this refusal goes back to the model: a sentence listing the channels is a
      // question it can put to the person, and "be more specific" is not.
      throw new RoutineRefusedError(
        `You are in more than one channel with me — ${nameThem(
          candidates,
        )}. Say which one.`,
      );
    }
    return only.id;
  }

  /**
   * How many of this person's routines are switched on. The cap counts these, not rows.
   *
   * Takes the transaction it must count on: a count made on another pooled connection would not see
   * the uncommitted row a racing create is about to add, which is the exact blindness the lock below
   * exists to remove.
   */
  async function countEnabled(
    handle: Transaction,
    ownerUserId: string,
  ): Promise<number> {
    const [row] = await handle
      .select({ total: sql<number>`count(*)::int` })
      .from(routines)
      .where(
        and(eq(routines.ownerUserId, ownerUserId), eq(routines.enabled, true)),
      );
    return row?.total ?? 0;
  }

  /**
   * Serialize this owner's cap-guarded writes: count and write under one advisory lock.
   *
   * The cap used to be a bare count-then-write, and two concurrent creates that both counted 19 both
   * inserted — the person held 21. An advisory lock rather than a row lock because the thing being
   * guarded is a COUNT: there is no one row whose `for update` covers "how many are enabled".
   * Transaction-scoped (`_xact_`), so the commit or the rollback releases it and never us forgetting.
   * `hashtext` collisions are harmless — two owners sharing a hash take turns, slower and not wrong.
   */
  async function withEnabledCapLock<T>(
    ownerUserId: string,
    work: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`routine-cap-${ownerUserId}`}))`,
      );
      return await work(transaction);
    });
  }

  async function loadOwned(
    ownerUserId: string,
    id: string,
  ): Promise<RoutineRow> {
    const [row] = await database
      .select()
      .from(routines)
      .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
      .limit(1);
    // A routine that is not yours is a routine that does not exist: the `setPinned` rule.
    if (!row) throw new RoutineNotFoundError();
    return row;
  }

  async function update(
    ownerUserId: string,
    id: string,
    patch: RoutinePatch,
  ): Promise<Routine> {
    const existing = await loadOwned(ownerUserId, id);

    const values: Partial<typeof routines.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.instruction !== undefined) {
      values.instruction = validInstruction(patch.instruction);
    }
    if (patch.agentId !== undefined || patch.channelId !== undefined) {
      const agentId = patch.agentId ?? existing.agentId;
      values.agentId = agentId;
      values.channelId = await resolveChannel(
        ownerUserId,
        agentId,
        patch.channelId ?? existing.channelId,
      );
    }
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.enabled === false) {
      // Pausing cancels the one deferred occurrence. Resuming recomputes the next schedule from now;
      // it must not resurrect work that was waiting before the person paused it.
      values.queuedFiringKey = null;
      values.queuedScheduledFor = null;
    }
    if (patch.overlapPolicy !== undefined) {
      values.overlapPolicy = validOverlapPolicy(patch.overlapPolicy);
      if (patch.overlapPolicy !== "queue_one") {
        values.queuedFiringKey = null;
        values.queuedScheduledFor = null;
      }
    }

    if (patch.cron !== undefined) values.cron = patch.cron;
    if (patch.timezone !== undefined) values.timezone = patch.timezone;

    /*
     * The cap is re-counted inside the lock, in the same transaction as the write. Counting outside
     * and writing inside would keep the very race the lock removes: two enables that both counted 19
     * before either committed.
     */
    const [row] = await withEnabledCapLock(ownerUserId, async (transaction) => {
      // Serialize pause/policy changes with scheduled openings and queue-one promotion. Without
      // this shared lock a pause could clear the reservation and an already-waiting firing could
      // write it back immediately afterwards, resurrecting work the person just cancelled.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`routine-run-${id}`}))`,
      );
      const [current] = await transaction
        .select()
        .from(routines)
        .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
        .limit(1);
      if (!current) throw new RoutineNotFoundError();

      const enabling = patch.enabled === true && !current.enabled;
      const cron = patch.cron ?? current.cron;
      const timezone = patch.timezone ?? current.timezone;
      /*
       * Recomputed for a new cron, a new zone, and for switching back on. That last one is the
       * subtle case: a routine switched off in June still holds June's `next_run_at`, and enabling
       * it without recomputing hands the sweep a firing that was due months ago.
       */
      if (
        patch.cron !== undefined ||
        patch.timezone !== undefined ||
        enabling
      ) {
        values.nextRunAt = nextRunFor(cron, timezone, new Date());
      }
      if (
        enabling &&
        (await countEnabled(transaction, ownerUserId)) >= MAX_ENABLED_ROUTINES
      ) {
        throw new RoutineRefusedError(TOO_MANY_ENABLED);
      }
      return await transaction
        .update(routines)
        .set(values)
        .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
        .returning();
    });
    if (!row) throw new RoutineNotFoundError();
    return toRoutine(row);
  }

  return {
    update,

    async readWorkerHeartbeat() {
      const [row] = await database
        .select({
          status: routineWorkerHeartbeats.status,
          heartbeatAt: routineWorkerHeartbeats.heartbeatAt,
          observedAt: sql<Date>`now()`,
        })
        .from(routineWorkerHeartbeats)
        .where(eq(routineWorkerHeartbeats.worker, "routine-worker"))
        .limit(1);
      return row ?? null;
    },

    async recordWorkerHeartbeat(status) {
      await database
        .insert(routineWorkerHeartbeats)
        .values({ worker: "routine-worker", status, heartbeatAt: sql`now()` })
        .onConflictDoUpdate({
          target: routineWorkerHeartbeats.worker,
          set: { status, heartbeatAt: sql`now()` },
        });
    },

    async create(input) {
      const instruction = validInstruction(input.instruction);
      const timezone = input.timezone ?? "UTC";
      const channelId = await resolveChannel(
        input.ownerUserId,
        input.agentId,
        input.channelId,
      );
      const nextRunAt = nextRunFor(input.cron, timezone, new Date());

      // Counted and inserted under the owner's cap lock, so two creates racing at 19 cannot both
      // count 19 and hand the person 21: the second waits, counts 20, and gets the refusal.
      const [row] = await withEnabledCapLock(
        input.ownerUserId,
        async (transaction) => {
          if (
            (await countEnabled(transaction, input.ownerUserId)) >=
            MAX_ENABLED_ROUTINES
          ) {
            throw new RoutineRefusedError(TOO_MANY_ENABLED);
          }
          return await transaction
            .insert(routines)
            .values({
              id: `routine_${crypto.randomUUID()}`,
              ownerUserId: input.ownerUserId,
              agentId: input.agentId,
              channelId,
              instruction,
              cron: input.cron,
              timezone,
              overlapPolicy: validOverlapPolicy(input.overlapPolicy ?? "skip"),
              nextRunAt,
            })
            .returning();
        },
      );
      // An insert that returned nothing is not a missing routine, it is a broken database: loud
      // rather than folded into the not-found sentence a caller is meant to be able to trust.
      if (!row) throw new Error("inserting a routine returned no row");
      return toRoutine(row);
    },

    async listFor(ownerUserId) {
      /*
       * The last-run join reads `routine_runs`, which only the sweep's half of this file writes to:
       * the page stays empty here until a routine has actually fired.
       *
       * `distinct on (routine_id) ... order by started_at desc` gives one row per routine, the most
       * recent, in a single index scan of `routine_runs_by_routine_idx`. Reading the runs in a
       * separate statement rather than a lateral keeps the main query one flat join.
       */
      const rows = await database
        .select({
          routine: routines,
          channelName: channels.name,
          channelDeletedAt: channels.deletedAt,
          // A left join, and the id is selected to tell "no channel row at all" (a hard delete
          // somewhere else) from "soft-deleted": both mean the target is unusable, and neither is
          // allowed to hide the routine, which is why `channel_id` is not a foreign key.
          channelExists: channels.id,
        })
        .from(routines)
        .leftJoin(channels, eq(channels.id, routines.channelId))
        .where(eq(routines.ownerUserId, ownerUserId))
        .orderBy(desc(routines.createdAt), desc(routines.id));

      const routineIds = rows.map((row) => row.routine.id);
      const lastRuns = new Map<
        string,
        { status: RoutineRunOutcome | null; finishedAt: Date | null }
      >();
      if (routineIds.length > 0) {
        const runRows = await database
          .selectDistinctOn([routineRuns.routineId], {
            routineId: routineRuns.routineId,
            status: routineRuns.status,
            finishedAt: routineRuns.finishedAt,
          })
          .from(routineRuns)
          .where(inArray(routineRuns.routineId, routineIds))
          .orderBy(
            routineRuns.routineId,
            desc(routineRuns.startedAt),
            // The id breaks the tie. Two runs of one routine can share a `started_at` — a retry in
            // the same instant, a clock with coarse resolution — and without a tiebreak `distinct
            // on` picks whichever of them the scan reached first, so the page's "last ran" would
            // flip between two rows for no reason a person could see.
            desc(routineRuns.id),
          );
        for (const run of runRows) {
          lastRuns.set(run.routineId, {
            status: run.status,
            finishedAt: run.finishedAt,
          });
        }
      }

      return rows.map(
        ({ routine, channelName, channelDeletedAt, channelExists }) => ({
          id: routine.id,
          agentId: routine.agentId,
          instruction: routine.instruction,
          schedule: describeCron(routine.cron),
          cron: routine.cron,
          timezone: routine.timezone,
          enabled: routine.enabled,
          overlapPolicy: routine.overlapPolicy,
          nextRunAt: routine.nextRunAt,
          channelId: routine.channelId,
          channelName,
          channelDeleted: channelExists === null || channelDeletedAt !== null,
          lastRun: lastRuns.get(routine.id) ?? null,
        }),
      );
    },

    async remove(ownerUserId, id) {
      // Hard, unlike a channel: nothing reads a routine that was deleted, and its runs cascade.
      const deleted = await database
        .delete(routines)
        .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
        .returning({ id: routines.id });
      if (deleted.length === 0) throw new RoutineNotFoundError();
    },

    async setEnabled(ownerUserId, id, enabled) {
      // One field through the same path, so enabling re-checks the cap and recomputes the next run
      // rather than having a second, quieter version of those rules.
      await update(ownerUserId, id, { enabled });
    },

    async listRunsFor(ownerUserId, id, limit) {
      await loadOwned(ownerUserId, id);
      const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
      const rows = await database
        .select({
          id: routineRuns.id,
          startedAt: routineRuns.startedAt,
          finishedAt: routineRuns.finishedAt,
          status: routineRuns.status,
          error: routineRuns.error,
        })
        .from(routineRuns)
        .where(eq(routineRuns.routineId, id))
        .orderBy(desc(routineRuns.startedAt), desc(routineRuns.id))
        .limit(boundedLimit);
      return rows.map((run) => ({
        id: run.id,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        durationMs: run.finishedAt
          ? Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime())
          : null,
        errorSummary: safeRoutineRunError(run.error),
      }));
    },

    async insertManualRun(ownerUserId, id) {
      return await database.transaction(async (transaction) => {
        const owned = await transaction
          .select({ id: routines.id })
          .from(routines)
          .where(
            and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)),
          )
          .limit(1);
        if (owned.length === 0) throw new RoutineNotFoundError();
        const opened = await openRun(transaction, id, "refuse");
        return { runId: opened.runId };
      });
    },

    /* =========================================================================================
     * THE SWEEP'S HALF STARTS HERE.
     *
     * One store, because there is one table and one owner-guarding discipline to keep straight
     * about it; but the two halves read nothing alike. Above, every method takes an owner and
     * every failure is one person's — a bad cron, a channel they are not in — and none of them is
     * about two things happening at once. Below, nobody asks a question: a sweep on a clock reads
     * the ledger, and every method has to be read as a race between replicas.
     *
     * WHOSE CLOCK. The database's, for every moment these methods compare — the same discipline
     * `server/src/work/queue.ts` states in its header, for the same reason: a node ninety seconds
     * behind once wrote a lease Postgres considered expired on arrival, and two replicas ran the
     * same item. `now()` in SQL, never `Date.now()`.
     * ========================================================================================= */

    async dueRoutines(limit) {
      /*
       * NOT OWNER-SCOPED, ON PURPOSE. Every other method in this file is guarded by the owner, so
       * an unguarded one reads like an oversight; this one is the sweep's read, and the sweep has
       * no owner. It runs as no person and looks at every person's routines, which is exactly why
       * it returns ids and stamps and nothing a person wrote.
       */
      return await database
        .select({ id: routines.id, nextRunAt: routines.nextRunAt })
        .from(routines)
        .where(
          and(
            eq(routines.enabled, true),
            // The comparison Postgres makes against its own clock. A replica's `Date.now()` here
            // would decide what is due from a clock the row was never written by.
            lte(routines.nextRunAt, sql`now()`),
          ),
        )
        // Oldest due first, so a backlog drains in the order it built up. The id is a tiebreak, so
        // two routines due in the same instant come back in a fixed order rather than whichever
        // the index happened to hand over.
        .orderBy(asc(routines.nextRunAt), asc(routines.id))
        .limit(limit);
    },

    async advanceNextRun(id, from, computeFrom) {
      const [row] = await database
        .select({ cron: routines.cron, timezone: routines.timezone })
        .from(routines)
        .where(eq(routines.id, id))
        .limit(1);
      if (!row) return false;

      // `computeFrom` moves only where the next occurrence is measured from, never what the CAS
      // compares against: the sweep uses it to make a month-stale clock current in one pass, and
      // the guarantee that exactly one replica moves the row has to survive that.
      const next = nextRunFor(row.cron, row.timezone, computeFrom ?? from);

      /*
       * THE COMPARE-AND-SET IS THE WHOLE MECHANISM. `where next_run_at = from` means the row only
       * moves for the sweep that read that exact stamp: however many replicas see the same due
       * routine in the same second, exactly one update matches and the rest change nothing. False
       * means another sweep won, which is fine either way — the firing still happens once.
       *
       * And it happens AFTER the run is offered — `sweep.ts`'s ordering comment is the one to read
       * for why. The old fear here was that advancing after offering would double-fire on a crash
       * between the two; it doesn't, because the offer key carries the minute the firing was due, so
       * a re-offer of the same due stamp collides on `work_items`' `(kind, key)` primary key rather
       * than queueing a second run. That holds even for a firing that already finished: `finish`
       * marks the row rather than deleting it, so a finished row still conflicts. The compare-and-set
       * below is what makes the advance itself safe under the same race, which is a separate claim
       * from the ordering.
       *
       * The equality is on a stamp that round-trips: every writer of `next_run_at` computes it from
       * `nextOccurrence`, which lands on a cron boundary with no sub-second part, and the driver
       * binds a `Date` at millisecond precision. The column is microsecond-precision, so
       * `next_run_at = now()` written anywhere in SQL would put microseconds in a value this
       * comparison reads back truncated — and the CAS would stop matching, silently, for ever. This
       * one moment is the database's clock via a value the database gave us, not via `now()`.
       */
      const moved = await database
        .update(routines)
        .set({ nextRunAt: next, lastRunAt: from, updatedAt: sql`now()` })
        .where(and(eq(routines.id, id), eq(routines.nextRunAt, from)))
        .returning({ id: routines.id });
      return moved.length > 0;
    },

    async insertRun(routineId, firing) {
      return await database.transaction((transaction) =>
        openRun(transaction, routineId, "record-skip", firing),
      );
    },

    async queuedRoutines(limit) {
      const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const rows = await database.execute(sql`
        select r.id,
               r.queued_firing_key as "firingKey",
               r.queued_scheduled_for as "scheduledFor"
        from routines r
        where r.enabled = true
          and r.overlap_policy = 'queue_one'
          and r.queued_firing_key is not null
          and r.queued_scheduled_for is not null
          and not exists (
            select 1 from routine_runs rr
            where rr.routine_id = r.id and rr.status is null
          )
        order by r.queued_scheduled_for asc, r.id asc
        limit ${boundedLimit}
      `);
      const selected = (
        Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
      ) as { id: string; firingKey: string; scheduledFor: Date }[];
      return selected;
    },

    async runContext(runId) {
      /*
       * An inner join, so a run whose routine is gone reads as no row rather than as a firing with
       * nothing to say. `remove` is a hard delete and the runs cascade with it, so in practice both
       * sides disappear together; the join is what makes that one absence instead of two.
       */
      const [row] = await database
        .select({
          routineId: routines.id,
          ownerUserId: routines.ownerUserId,
          agentId: routines.agentId,
          channelId: routines.channelId,
          instruction: routines.instruction,
          overlapPolicy: routines.overlapPolicy,
        })
        .from(routineRuns)
        .innerJoin(routines, eq(routines.id, routineRuns.routineId))
        .where(eq(routineRuns.id, runId))
        .limit(1);
      return row ?? null;
    },

    async routineForFiring(id) {
      // A single select, not owner-scoped — the sweep's read, like `dueRoutines`. A routine id here
      // comes from a work item's own payload, not from a person, so there is no owner to check.
      const [row] = await database
        .select({ id: routines.id, enabled: routines.enabled })
        .from(routines)
        .where(eq(routines.id, id))
        .limit(1);
      return row ?? null;
    },

    async finishRun(runId, status, error) {
      await database
        .update(routineRuns)
        .set({
          status,
          // The database's clock closes the row, the same as it opened it.
          finishedAt: sql`now()`,
          // Left alone rather than nulled when there was no error, so finishing a run twice cannot
          // erase what the first finish recorded — and the `status is null` guard below is what
          // makes that true.
          ...(error === undefined
            ? {}
            : {
                // Measured in code points, like `validInstruction`, so an emoji-bearing error
                // cannot be cut mid-surrogate-pair.
                error: Array.from(error).slice(0, MAX_RUN_ERROR).join(""),
              }),
        })
        // A run finishes once. The second call — succeeded, then a downstream throw whose catch
        // calls finishRun("failed") — matches no row here and is a silent no-op, rather than
        // relabeling what the first finish already recorded.
        .where(and(eq(routineRuns.id, runId), isNull(routineRuns.status)));
    },

    async reapAbandonedRuns(olderThanMs, error) {
      /*
       * One UPDATE, not a select-then-loop: every row this WHERE matches is abandoned, and there is
       * nothing to decide per row that the age bound does not already decide. Both sides of the age
       * comparison are the database's clock — `started_at` was written by its `now()`, so measuring
       * it against a replica's `Date.now()` would let ninety seconds of skew reap a run some server
       * is still running, which is this file's standing clock discipline.
       */
      const closed = await database
        .update(routineRuns)
        .set({
          status: "skipped",
          finishedAt: sql`now()`,
          // Same code-point cap as `finishRun`, so a reap reason cannot be cut mid-surrogate-pair.
          error: Array.from(error).slice(0, MAX_RUN_ERROR).join(""),
        })
        .where(
          and(
            isNull(routineRuns.status),
            lte(
              routineRuns.startedAt,
              sql`now() - (${olderThanMs} * interval '1 millisecond')`,
            ),
          ),
        )
        .returning({ id: routineRuns.id });
      return closed.length;
    },

    async markUnschedulable(id, reason) {
      const disabled = await database
        .update(routines)
        .set({ enabled: false, updatedAt: sql`now()` })
        .where(eq(routines.id, id))
        .returning({ id: routines.id });
      // Deleted between the sweep's read and this write: gone is gone, and a run row inserted here
      // would only violate the foreign key of a routine nobody can see any more.
      if (disabled.length === 0) return;
      // A finished "skipped" row rather than "failed": no turn ran, so the fatigue rule must not
      // count this, and skipped is exactly the vocabulary for a firing that never became a turn.
      await database.insert(routineRuns).values({
        id: `routine_run_${crypto.randomUUID()}`,
        routineId: id,
        status: "skipped",
        finishedAt: sql`now()`,
        error: Array.from(reason).slice(0, MAX_RUN_ERROR).join(""),
      });
    },

    async consecutiveFailures(routineId) {
      /*
       * Bounded, then counted here. The bound is the point: this is read on every failed firing,
       * for ever, and `select ... where routine_id = $1` with no limit gets slower for exactly the
       * routines that fail most. The rule only acts on the first handful, so reading twice that
       * many and stopping is the whole answer.
       *
       * Finished runs only — an in-flight run has no outcome yet and must not end the streak.
       */
      const rows = await database
        .select({ status: routineRuns.status })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.routineId, routineId),
            isNotNull(routineRuns.status),
            /*
             * A SKIP IS NOT A FAILURE, AND DOES NOT BREAK THE STREAK. It means no turn ran — the
             * channel was gone, the dispatch never reached the server, or a restart abandoned the
             * run — not that the turn failed, so it is not counted; and it does not reset the
             * count either, because a routine whose channel flaps would otherwise never reach the
             * fatigue rule — it would disable itself over ten missing channels, or never at all.
             * Excluding it here, rather than reading it and skipping over it below, keeps it from
             * consuming a slot in the bounded window: a routine that skips twice for every
             * failure must still be able to count past ten failures, not top out around six or
             * seven because skips ate two-thirds of the rows the window could hold.
             */
            ne(routineRuns.status, "skipped"),
          ),
        )
        .orderBy(desc(routineRuns.startedAt), desc(routineRuns.id))
        .limit(FAILURE_SCAN_LIMIT);

      let failures = 0;
      for (const run of rows) {
        if (run.status !== "failed") break;
        failures += 1;
      }
      return failures;
    },
  };
}
