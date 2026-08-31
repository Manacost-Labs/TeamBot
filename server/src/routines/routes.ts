import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventType, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { RoutineRunner } from "./runner";
import {
  RoutineNotFoundError,
  RoutineOverlapError,
  type RoutinePatch,
  RoutineRefusedError,
  type RoutineRunOutcome,
  type RoutineStore,
  type RoutineSummary,
} from "./store";

export type { RoutineStore } from "./store";

export type RoutineRouteOptions = {
  runner?: RoutineRunner;
  auditStore?: AuditStore;
};

/** Two missed production CronJob windows plus their scheduling margin. */
export const ROUTINE_WORKER_STALE_AFTER_MS = 12 * 60_000;

/**
 * The routines page API. Creation stays conversational through the four `RoutineTools`; once a
 * routine exists, this owner-scoped surface lists, edits, pauses, runs and removes it.
 *
 * There is no GET-by-id: the list is the editable record, while `/:id/runs` is its bounded ledger.
 *
 * Owner-scoped through the store on every route, never by filtering a broader read afterwards:
 * `listFor`, `setEnabled` and `remove` all take the caller's id and answer as if a routine that
 * belongs to somebody else does not exist, which is what keeps a wrong id and somebody else's id
 * indistinguishable from outside.
 */
export function createRoutineRoutes(
  routineStore: RoutineStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: RoutineRouteOptions = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /** Record only control metadata; instructions and schedule contents never enter the audit row. */
  const record = async (
    context: Context<{ Variables: AppVariables }>,
    eventType: Extract<AuditEventType, `routine.${string}`>,
    routineId: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!options.auditStore) return;
    try {
      await recordAuditEvent(options.auditStore, {
        eventType,
        targetType: "routine",
        targetId: routineId,
        ...(context.var.actor.email === "dev@openbot.local"
          ? {}
          : { actorUserId: context.var.actor.id }),
        payload,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "routine-audit-write-failed",
          eventType,
          routineId,
          error: String(error),
        }),
      );
    }
  };

  routes.get("/", requireUser, async (context) => {
    const routines = await routineStore.listFor(context.var.actor.id);
    return context.json({ routines: routines.map(routineDto) });
  });

  routes.get("/health", requireUser, async (context) => {
    let heartbeat: Awaited<ReturnType<RoutineStore["readWorkerHeartbeat"]>>;
    try {
      heartbeat = await routineStore.readWorkerHeartbeat();
    } catch (error) {
      // A failed health read is not proof that the worker is healthy. Keep the member-facing answer
      // coarse, while the server log retains only the error category and no routine data.
      console.warn(
        JSON.stringify({
          type: "routine-worker-health-read-failed",
          reason: error instanceof Error ? error.name : "unknown",
        }),
      );
      return context.json({
        worker: { status: "unavailable", lastHeartbeatAt: null },
      });
    }

    if (!heartbeat) {
      return context.json({
        worker: { status: "unavailable", lastHeartbeatAt: null },
      });
    }

    // Both stamps come from Postgres. Comparing against an API pod's wall clock would call a live
    // worker stale (or a dead one fresh) when the pod clock drifts from the database.
    const ageMs =
      heartbeat.observedAt.getTime() - heartbeat.heartbeatAt.getTime();
    const status =
      heartbeat.status === "failed"
        ? "unavailable"
        : ageMs < 0
          ? "unavailable"
          : ageMs > ROUTINE_WORKER_STALE_AFTER_MS
            ? "stale"
            : "operational";
    return context.json({
      worker: {
        status,
        lastHeartbeatAt: heartbeat.heartbeatAt.toISOString(),
      },
    });
  });

  routes.put("/:id/enabled", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      return context.json({ error: "enabled must be true or false." }, 400);
    }

    try {
      await routineStore.setEnabled(
        context.var.actor.id,
        context.req.param("id"),
        enabled,
      );
      await record(
        context,
        "routine.enabled_changed",
        context.req.param("id"),
        { enabled },
      );
      return context.json({ enabled });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.patch("/:id", requireUser, async (context) => {
    const parsed = parsePatch(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const id = context.req.param("id");
    try {
      await routineStore.update(context.var.actor.id, id, parsed.patch);
      await record(context, "routine.updated", id, {
        fields: Object.keys(parsed.patch).sort(),
      });
      return context.json({ updated: true });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:id/runs", requireUser, async (context) => {
    if (!routineStore.listRunsFor) {
      return context.json({ error: "Routine history is not available." }, 503);
    }
    try {
      const runs = await routineStore.listRunsFor(
        context.var.actor.id,
        context.req.param("id"),
        20,
      );
      return context.json({
        runs: runs.map((run) => ({
          id: run.id,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          status: run.status,
          durationMs: run.durationMs,
          error: run.errorSummary,
        })),
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:id/run", requireUser, async (context) => {
    if (!routineStore.insertManualRun || !options.runner) {
      return context.json({ error: "Manual runs are not available." }, 503);
    }
    const id = context.req.param("id");
    try {
      const { runId } = await routineStore.insertManualRun(
        context.var.actor.id,
        id,
      );
      await record(context, "routine.manual_run_requested", id, { runId });
      void options.runner.run(runId).catch(() => {});
      return context.json({ accepted: true, runId }, 202);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    try {
      const id = context.req.param("id");
      await routineStore.remove(context.var.actor.id, id);
      await record(context, "routine.deleted", id);
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

/**
 * One row of the routines page.
 *
 * THE DTO CARRIES THE WORDS, NOT THE CRON. The client never parses a schedule, so words-from-cron is
 * computed once, server-side, by the same library that decides when a routine actually fires — there
 * is no second implementation of cron-to-English anywhere to drift out of step with it. `schedule` is
 * opaque display text, never a value to parse: prose for the shapes `describeCron` recognizes, and
 * the raw five-field expression for everything stranger than that. `nextRunAt` is the one place a
 * time is computed, and it is computed the same way, by `nextOccurrence`.
 */
type RoutineDto = {
  id: string;
  agentId: string;
  schedule: string;
  cron: string;
  timezone: string;
  instruction: string;
  channel: { id: string; name: string | null; gone: boolean };
  enabled: boolean;
  nextRunAt: string;
  lastRun: { status: RoutineRunOutcome | null; at: string | null } | null;
  overlapPolicy: "skip";
};

function routineDto(routine: RoutineSummary): RoutineDto {
  return {
    id: routine.id,
    agentId: routine.agentId,
    schedule: routine.schedule,
    cron: routine.cron,
    timezone: routine.timezone,
    instruction: routine.instruction,
    channel: {
      id: routine.channelId,
      name: routine.channelName,
      gone: routine.channelDeleted,
    },
    enabled: routine.enabled,
    nextRunAt: routine.nextRunAt.toISOString(),
    lastRun: routine.lastRun
      ? {
          status: routine.lastRun.status,
          at: routine.lastRun.finishedAt?.toISOString() ?? null,
        }
      : null,
    overlapPolicy: "skip",
  };
}

type ParsedPatch =
  | { ok: true; patch: RoutinePatch }
  | { ok: false; error: string };

function parsePatch(input: unknown): ParsedPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Routine input must be a JSON object." };
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set([
    "instruction",
    "cron",
    "timezone",
    "channelId",
    "enabled",
  ]);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown)
    return { ok: false, error: `Unknown routine field: ${unknown}.` };

  const patch: RoutinePatch = {};
  for (const field of [
    "instruction",
    "cron",
    "timezone",
    "channelId",
  ] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string") {
      return { ok: false, error: `${field} must be text.` };
    }
    patch[field] = body[field];
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "enabled must be true or false." };
    }
    patch.enabled = body.enabled;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Say what to change about that routine." };
  }
  return { ok: true, patch };
}

function mapStoreError(context: Context, error: unknown): Response {
  // The store's own sentence, verbatim: it already reads the same whether the id belongs to nobody
  // or to somebody else, which is what keeps ownership unprobeable from out here.
  if (error instanceof RoutineNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  if (error instanceof RoutineRefusedError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof RoutineOverlapError) {
    return context.json({ error: error.message }, 409);
  }
  throw error;
}
