import { type Message, MessageSchema } from "@ag-ui/core";
import { ClientTimeoutError, client } from "@/lib/client";
import type { HistoryPage } from "./conversation-store";

export type { HistoryPage } from "./conversation-store";

/**
 * The messages a thread already holds, for restoring a conversation somebody comes back to.
 *
 * A plain fail-closed function rather than a query. Nothing caches it — the transcript this seeds is
 * then owned by the running agent, so a cached copy would be a second version of the same
 * conversation — and an unreadable history is not a reason to keep somebody from typing. Every
 * failure returns nothing and lets the composer open.
 *
 * WHAT ARRIVES HERE IS NOT TRUSTED. This used to end `stored as Message[]`, which is a cast rather
 * than a check: whatever the history store held was handed to `setMessages` and then to every
 * projection that reads a transcript. A turn shaped differently reached a renderer that dereferenced
 * `toolCall.function.arguments` and took the whole conversation down with it. One bad turn made a
 * thread unreadable.
 *
 * So each turn is parsed against the schema AG-UI ships, and one that does not parse is left out.
 * Checked here rather than in a projection because there are several projections and one history:
 * fixing it in the reader that is closest to the wire is what makes every consumer safe at once.
 *
 * BUT `{id, name, args}` IS NOT A CORRUPTION, AND TREATING IT AS ONE DELETED REAL WORK. That shape
 * was read as damage from an interrupted run and dropped. It is how the runtime persists every tool
 * call it stores, so dropping it meant every turn in which a Bot used a tool vanished on reload: the
 * transcript kept the sentence the Bot wrote and lost the browsing that produced it, the inline
 * screen went with it, and the footer said some messages could not be read. Observed against a live
 * thread, where every browsing turn was counted unreadable and every one of them was well formed in
 * the store's own dialect.
 *
 * So it is translated rather than refused. The check stays for turns that really are malformed; a
 * reader is entitled to insist on one shape, but not to throw away the history because the writer
 * spells it another way.
 */

/**
 * What a read gives back: the turns that parsed, and how many did not.
 *
 * The count is returned rather than logged. A turn quietly missing from a record people read back is
 * worse than a visible failure — it is a conversation that reads as though it never had that message,
 * with nothing to say otherwise. The caller is expected to say so on screen.
 */
export type StoredThread = {
  messages: Message[];
  /** Zero on every ordinary read. Above zero means the history store holds something unreadable. */
  unreadable: number;
  /** Present when the server returned the bounded history contract. */
  olderCursor?: string | null;
  hasOlder?: boolean;
  revision?: string;
};

export type StoredHistoryPage = HistoryPage & {
  unreadable: number;
};

const NOTHING: StoredThread = { messages: [], unreadable: 0 };

/**
 * History is a remote, durable read rather than a short UI request. Keep one deadline for the
 * initial read, reconciliation and older-page pagination so a slow Intelligence response cannot
 * leave a channel (or the composer) waiting forever.
 */
export const THREAD_HISTORY_REQUEST_TIMEOUT_MS = 12_000;

/** Turn transport-specific timeout text into a useful message for a person. */
export function historyErrorMessage(
  error: unknown,
  fallback = "Не удалось обновить историю диалога.",
): string {
  if (error instanceof ClientTimeoutError) {
    return "Сервер истории не ответил вовремя. Повторите загрузку.";
  }
  const message =
    error instanceof Error ? error.message.trim() : String(error).trim();
  if (/timed out|timeout|signal timed out/i.test(message)) {
    return "Сервер истории не ответил вовремя. Повторите загрузку.";
  }
  return message || fallback;
}

export type CachedStoredThread = StoredThread & {
  /** Cache is a paint-first snapshot; every channel open revalidates it against the server. */
  stale: true;
  /** False when the bounded cache contains only the authoritative history's newest tail. */
  complete: boolean;
  cachedAt: number;
};

type ThreadHistoryCacheOptions = {
  maxEntries?: number;
  maxMessagesPerEntry?: number;
  now?: () => number;
};

const HISTORY_CACHE_MAX_ENTRIES = 12;
const HISTORY_CACHE_MAX_MESSAGES = 500;
const PREFETCH_DEDUP_MS = 5_000;

function historyCacheKey(
  sessionScope: string,
  threadId: string,
  agentId: string,
): string {
  return `${encodeURIComponent(sessionScope)}:${encodeURIComponent(agentId)}:${encodeURIComponent(threadId)}`;
}

/** Bounded, authenticated-session-scoped history used only for instant paint before revalidation. */
export class ThreadHistoryCache {
  private readonly entries = new Map<string, CachedStoredThread>();
  private readonly scopeEpochs = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly maxMessagesPerEntry: number;
  private readonly now: () => number;

  constructor(options: ThreadHistoryCacheOptions = {}) {
    this.maxEntries = Math.max(
      1,
      options.maxEntries ?? HISTORY_CACHE_MAX_ENTRIES,
    );
    this.maxMessagesPerEntry = Math.max(
      1,
      options.maxMessagesPerEntry ?? HISTORY_CACHE_MAX_MESSAGES,
    );
    this.now = options.now ?? Date.now;
  }

  peek(
    sessionScope: string,
    threadId: string,
    agentId: string,
  ): CachedStoredThread | null {
    const key = historyCacheKey(sessionScope, threadId, agentId);
    const cached = this.entries.get(key);
    if (!cached) return null;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached;
  }

  set(
    sessionScope: string,
    threadId: string,
    agentId: string,
    value: StoredThread,
  ): CachedStoredThread {
    const key = historyCacheKey(sessionScope, threadId, agentId);
    const complete =
      value.hasOlder !== true &&
      value.messages.length <= this.maxMessagesPerEntry;
    const cached: CachedStoredThread = {
      messages: value.messages.slice(-this.maxMessagesPerEntry),
      unreadable: value.unreadable,
      cachedAt: this.now(),
      stale: true,
      complete,
      ...(value.olderCursor !== undefined
        ? { olderCursor: value.olderCursor }
        : {}),
      ...(value.hasOlder !== undefined ? { hasOlder: value.hasOlder } : {}),
      ...(value.revision !== undefined ? { revision: value.revision } : {}),
    };
    this.entries.delete(key);
    this.entries.set(key, cached);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return cached;
  }

  epoch(sessionScope: string): number {
    return this.scopeEpochs.get(sessionScope) ?? 0;
  }

  setIfCurrent(
    sessionScope: string,
    threadId: string,
    agentId: string,
    epoch: number,
    value: StoredThread,
  ): CachedStoredThread | null {
    return this.epoch(sessionScope) === epoch
      ? this.set(sessionScope, threadId, agentId, value)
      : null;
  }

  invalidate(sessionScope: string, threadId: string, agentId: string): void {
    this.entries.delete(historyCacheKey(sessionScope, threadId, agentId));
  }

  clearScope(sessionScope: string): void {
    this.scopeEpochs.set(sessionScope, this.epoch(sessionScope) + 1);
    const prefix = `${encodeURIComponent(sessionScope)}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

export function createThreadHistoryCache(
  options: ThreadHistoryCacheOptions = {},
): ThreadHistoryCache {
  return new ThreadHistoryCache(options);
}

const threadHistoryCache = createThreadHistoryCache();
/**
 * One latest history read per authenticated thread.
 *
 * Sidebar hover/focus can start a read just before the channel mounts. Keeping that promise here
 * lets the active view adopt it instead of opening a second request to the same remote store. The
 * map is intentionally process-local to this tab and keyed by the authenticated scope, so a
 * sign-in transition can never join another person's pending read.
 */
const pendingHistoryReads = new Map<string, Promise<StoredThread>>();
/** Per-thread generation prevents a late speculative response from repopulating a cache after a write. */
const threadHistoryInvalidationEpochs = new Map<string, number>();

export function cachedThreadMessages(
  sessionScope: string,
  threadId: string,
  agentId: string,
): CachedStoredThread | null {
  return threadHistoryCache.peek(sessionScope, threadId, agentId);
}

/** Drop a cached snapshot as soon as this tab starts writing to the same thread. */
export function invalidateThreadMessagesCache(
  sessionScope: string,
  threadId: string,
  agentId: string,
): void {
  const key = historyCacheKey(sessionScope, threadId, agentId);
  threadHistoryCache.invalidate(sessionScope, threadId, agentId);
  threadHistoryInvalidationEpochs.set(
    key,
    (threadHistoryInvalidationEpochs.get(key) ?? 0) + 1,
  );
  // The underlying fetch cannot always be cancelled (it may be shared), but a future refresh must
  // never adopt this obsolete promise after the local write.
  pendingHistoryReads.delete(key);
}

export function clearThreadMessagesCache(sessionScope: string): void {
  threadHistoryCache.clearScope(sessionScope);
  const prefix = `${encodeURIComponent(sessionScope)}:`;
  for (const key of pendingHistoryReads.keys()) {
    if (key.startsWith(prefix)) pendingHistoryReads.delete(key);
  }
  for (const key of threadHistoryInvalidationEpochs.keys()) {
    if (key.startsWith(prefix)) threadHistoryInvalidationEpochs.delete(key);
  }
}

/** Server order wins; structurally unchanged rows retain their identity for memoized rendering. */
export function mergeThreadMessagesById(
  previous: readonly Message[],
  fresh: readonly Message[],
  options: { retainMissing?: boolean } = {},
): Message[] {
  const previousById = new Map(
    previous.map((message) => [message.id, message]),
  );
  const freshIds = new Set(fresh.map((message) => message.id));
  const merged = fresh.map((message) => {
    const existing = previousById.get(message.id);
    return existing && sameMessage(existing, message) ? existing : message;
  });
  // Local streamed/optimistic messages may not have reached persistence yet.
  return options.retainMissing === false
    ? merged
    : [...merged, ...previous.filter((message) => !freshIds.has(message.id))];
}

/**
 * Replace a stale snapshot with the server's complete revision while preserving writes this tab
 * has made that may not have reached persistence yet.
 *
 * Before the first local write, every missing row came from the stale cache and is discarded. Once
 * writing starts, the runtime may have optimistic, streamed, tool and user rows not persisted yet;
 * those are retained because removing any one of them can break the live run.
 */
export function mergeAuthoritativeThreadMessages(
  previous: readonly Message[],
  fresh: readonly Message[],
  localWriteStarted: boolean,
): Message[] {
  return mergeThreadMessagesById(previous, fresh, {
    retainMissing: localWriteStarted,
  });
}

function sameMessage(left: Message, right: Message): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * The turns that parse, kept in order, and a count of the ones that did not.
 *
 * Exported so it can be tested against real stored shapes without a server. Takes `unknown[]`
 * because that is honestly what the wire gives.
 *
 * THE ORIGINAL OBJECT IS KEPT, not `parsed.data`. Zod strips keys a schema does not name, so
 * returning the parsed copy would quietly drop anything the runtime carries and this file has not
 * heard of — turning a validation step into a silent rewrite of every message that passed. The parse
 * is asked whether the turn is well formed; it is not asked to decide what the turn contains.
 */
export function readableTurns(stored: readonly unknown[]): StoredThread {
  const messages: Message[] = [];
  let unreadable = 0;

  for (const turn of stored) {
    const candidate = withNormalisedToolCalls(
      withoutNullAssistantContent(turn),
    );
    if (MessageSchema.safeParse(candidate).success) {
      messages.push(candidate as Message);
    } else {
      unreadable += 1;
    }
  }

  return { messages, unreadable };
}

/**
 * An assistant turn whose content is `null`, read as one that simply has no content.
 *
 * The schema makes an assistant's content optional and does not allow it to be null, so the two say
 * the same thing and only one parses. A turn that called a tool and said nothing alongside it is
 * written exactly that way, so this dropped the browsing and kept nothing in its place: the same
 * loss the tool-call dialect caused, arriving by a different route.
 *
 * ASSISTANT ONLY. A user turn's content is required, and `content: null` there is not a message
 * somebody sent; it used to reach a projection and draw as a blank line, which is why it is refused
 * and counted rather than quietly shown. That decision stands.
 */
function withoutNullAssistantContent(turn: unknown): unknown {
  if (typeof turn !== "object" || turn === null) return turn;
  const record = turn as Record<string, unknown>;
  if (record.role !== "assistant" || record.content !== null) return turn;
  const { content: _dropped, ...rest } = record;
  return rest;
}

/** A tool call as the history store writes one. */
type StoredToolCall = { id?: unknown; name?: unknown; args?: unknown };

/**
 * The store's dialect for a tool call, in the shape AG-UI describes.
 *
 * `{id, name, args}` becomes `{id, type: "function", function: {name, arguments}}`. Only the array is
 * rebuilt and only when every entry is in that dialect: a turn already in AG-UI's shape is returned
 * untouched, and a mixed or unrecognised array is left exactly as it came so the parse below still
 * refuses it rather than this quietly inventing something.
 *
 * The rest of the message is spread through unchanged, for the same reason `parsed.data` is not used
 * anywhere here: a reader that rewrites what it does not recognise is worse than one that refuses it.
 */
function withNormalisedToolCalls(turn: unknown): unknown {
  if (typeof turn !== "object" || turn === null) return turn;
  const calls = (turn as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(calls) || calls.length === 0) return turn;

  const isStoredDialect = (call: unknown): call is StoredToolCall =>
    typeof call === "object" &&
    call !== null &&
    "name" in call &&
    "args" in call &&
    !("function" in call);
  if (!calls.every(isStoredDialect)) return turn;

  return {
    ...(turn as Record<string, unknown>),
    toolCalls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: argumentsOf(call.args) },
    })),
  };
}

/**
 * The arguments, as a string, because that is what the protocol says they are.
 *
 * AG-UI types `arguments` as a string and the store is under no such obligation: it holds whatever
 * the run put there, which for a tool called with structured input is an object. Passing that through
 * produced a call that looked translated and still failed validation, so the turn was dropped anyway.
 * That is this whole function's bug one layer down, which is a good reason to be explicit here rather
 * than to trust the shapes to line up.
 *
 * A string is already right and is left exactly as it is, down to its whitespace: it may be a
 * fragment of a stream that was never valid JSON, and re-encoding it would change what the model
 * actually said. Anything else is encoded. `undefined` becomes `"{}"`, which is what a call with no
 * arguments means and what every reader of this field expects to parse.
 */
function argumentsOf(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args);
  } catch {
    // Circular, or something else that cannot be encoded. An empty object is a call the reader can
    // parse; a throw here would lose the whole conversation over one malformed argument list.
    return "{}";
  }
}

/** Parse both the current full-history response and the future cursor page response. */
export function readableHistoryPage(
  payload: unknown,
  fallbackRevision = "legacy",
): StoredHistoryPage {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Не удалось прочитать историю диалога.");
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.messages)) {
    throw new Error("Не удалось прочитать историю диалога.");
  }
  const readable = readableTurns(record.messages);
  const olderCursor =
    typeof record.olderCursor === "string" ? record.olderCursor : null;
  return {
    messages: readable.messages,
    olderCursor,
    hasOlder:
      typeof record.hasOlder === "boolean"
        ? record.hasOlder
        : olderCursor !== null,
    revision:
      typeof record.revision === "string" ? record.revision : fallbackRevision,
    unreadable: readable.unreadable,
  };
}

function threadHistoryPath(
  threadId: string,
  agentId: string,
  olderCursor?: string | null,
): string {
  const params = new URLSearchParams({ agentId });
  if (olderCursor) params.set("before", olderCursor);
  return `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?${params.toString()}`;
}

export async function readThreadMessages(
  threadId: string,
  agentId: string,
  options: { fresh?: boolean; sessionScope?: string } = {},
): Promise<StoredThread> {
  const sessionScope = options.sessionScope ?? "legacy-tab";
  if (!options.fresh) {
    const cached = threadHistoryCache.peek(sessionScope, threadId, agentId);
    if (cached) return cached;
  }

  try {
    return await refreshThreadMessages(sessionScope, threadId, agentId);
  } catch {
    return NOTHING;
  }
}

/**
 * Reads the authenticated server, joining a pending prefetch and reusing its just-finished snapshot
 * when possible; callers decide how an explicit refresh failure is shown.
 */
export async function refreshThreadMessages(
  sessionScope: string,
  threadId: string,
  agentId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<StoredThread> {
  options.signal?.throwIfAborted();

  /*
   * A prefetch that completed moments ago is already the fresh server answer the active view needs.
   * Reusing it removes the click -> duplicate GET round trip while keeping the window deliberately
   * tiny; writes invalidate the cache immediately, so this cannot hide a local message.
   */
  const recent = threadHistoryCache.peek(sessionScope, threadId, agentId);
  if (recent && Date.now() - recent.cachedAt < PREFETCH_DEDUP_MS) {
    options.signal?.throwIfAborted();
    return recent;
  }

  const key = historyCacheKey(sessionScope, threadId, agentId);
  const pending = pendingHistoryReads.get(key);
  if (pending) {
    try {
      const result = await pending;
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      /*
       * A speculative request may be cancelled by the bounded hover scheduler. Do not make the
       * active channel inherit that cancellation: remove the failed promise and retry it with the
       * active caller's deadline. Explicit cancellation of the active caller still wins.
       */
      if (options.signal?.aborted) throw error;
      if (pendingHistoryReads.get(key) === pending) {
        pendingHistoryReads.delete(key);
      }
    }
  }

  const request = refreshThreadMessagesDirect(
    sessionScope,
    threadId,
    agentId,
    options,
  );
  pendingHistoryReads.set(key, request);
  try {
    return await request;
  } finally {
    if (pendingHistoryReads.get(key) === request) {
      pendingHistoryReads.delete(key);
    }
  }
}

/** Perform the actual authenticated read. Callers above this boundary handle sharing/retries. */
async function refreshThreadMessagesDirect(
  sessionScope: string,
  threadId: string,
  agentId: string,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<StoredThread> {
  const key = historyCacheKey(sessionScope, threadId, agentId);
  const invalidationEpoch = threadHistoryInvalidationEpochs.get(key) ?? 0;
  const cacheEpoch = threadHistoryCache.epoch(sessionScope);
  const response = await client(threadHistoryPath(threadId, agentId), {
    fallback: "Не удалось обновить историю диалога",
    // Preserve a caller-owned cancellation signal when no deadline was requested explicitly. The
    // channel supplies the shared deadline; low-level callers that only cancel on sign-out should
    // keep receiving that exact signal and reason.
    ...(options.timeoutMs !== undefined || options.signal === undefined
      ? { timeoutMs: options.timeoutMs ?? THREAD_HISTORY_REQUEST_TIMEOUT_MS }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const page = readableHistoryPage(await response.json());
  const result: StoredThread = {
    messages: page.messages,
    unreadable: page.unreadable,
    hasOlder: page.hasOlder,
    olderCursor: page.olderCursor,
    revision: page.revision,
  };
  // A sign-out or scope switch can happen while response JSON is being parsed. The signal is the
  // fast cancellation path; the captured epoch also covers authoritative refreshes with no signal.
  options.signal?.throwIfAborted();
  if ((threadHistoryInvalidationEpochs.get(key) ?? 0) === invalidationEpoch) {
    threadHistoryCache.setIfCurrent(
      sessionScope,
      threadId,
      agentId,
      cacheEpoch,
      result,
    );
  }
  return result;
}

/** Read one bounded page when the runtime exposes the cursor history contract. */
export async function refreshThreadHistoryPage(
  _sessionScope: string,
  threadId: string,
  agentId: string,
  options: {
    olderCursor?: string | null;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<StoredHistoryPage> {
  const response = await client(
    threadHistoryPath(threadId, agentId, options.olderCursor),
    {
      fallback: "Не удалось обновить историю диалога",
      ...(options.timeoutMs !== undefined || options.signal === undefined
        ? { timeoutMs: options.timeoutMs ?? THREAD_HISTORY_REQUEST_TIMEOUT_MS }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const page = readableHistoryPage(await response.json());
  options.signal?.throwIfAborted();
  return page;
}

/** Warm a channel from roster hover/focus without producing duplicate requests or hidden errors. */
export async function prefetchThreadMessages(
  sessionScope: string,
  threadId: string,
  agentId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const cached = threadHistoryCache.peek(sessionScope, threadId, agentId);
  if (cached && Date.now() - cached.cachedAt < PREFETCH_DEDUP_MS) return;
  try {
    // `refreshThreadMessages` owns the shared in-flight registry. An active channel can therefore
    // promote this speculative request without starting another Intelligence read.
    await refreshThreadMessages(sessionScope, threadId, agentId, options);
  } catch {
    // The opened channel owns the explicit refresh error; hover prefetch has no surface to report it.
  }
}
