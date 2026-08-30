import { type Message, MessageSchema } from "@ag-ui/core";
import { client } from "@/lib/client";

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
};

const NOTHING: StoredThread = { messages: [], unreadable: 0 };

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
    const complete = value.messages.length <= this.maxMessagesPerEntry;
    const cached: CachedStoredThread = {
      messages: value.messages.slice(-this.maxMessagesPerEntry),
      unreadable: value.unreadable,
      cachedAt: this.now(),
      stale: true,
      complete,
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
const prefetches = new Map<string, Promise<StoredThread>>();

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
  threadHistoryCache.invalidate(sessionScope, threadId, agentId);
}

export function clearThreadMessagesCache(sessionScope: string): void {
  threadHistoryCache.clearScope(sessionScope);
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

/** Always asks the authenticated server; callers decide how an explicit refresh failure is shown. */
export async function refreshThreadMessages(
  sessionScope: string,
  threadId: string,
  agentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<StoredThread> {
  const cacheEpoch = threadHistoryCache.epoch(sessionScope);
  const response = await client(
    `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`,
    {
      fallback: "Не удалось обновить историю диалога",
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const stored = (await response.json())?.messages;
  if (!Array.isArray(stored)) {
    throw new Error("Не удалось прочитать историю диалога.");
  }
  const result = readableTurns(stored);
  // A sign-out or scope switch can happen while response JSON is being parsed. The signal is the
  // fast cancellation path; the captured epoch also covers authoritative refreshes with no signal.
  options.signal?.throwIfAborted();
  threadHistoryCache.setIfCurrent(
    sessionScope,
    threadId,
    agentId,
    cacheEpoch,
    result,
  );
  return result;
}

/** Warm a channel from roster hover/focus without producing duplicate requests or hidden errors. */
export async function prefetchThreadMessages(
  sessionScope: string,
  threadId: string,
  agentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const cached = threadHistoryCache.peek(sessionScope, threadId, agentId);
  if (cached && Date.now() - cached.cachedAt < PREFETCH_DEDUP_MS) return;
  const key = historyCacheKey(sessionScope, threadId, agentId);
  const pending = prefetches.get(key);
  if (pending) {
    await pending.catch(() => {});
    return;
  }
  const refresh = refreshThreadMessages(
    sessionScope,
    threadId,
    agentId,
    options,
  );
  prefetches.set(key, refresh);
  try {
    await refresh;
  } catch {
    // The opened channel owns the explicit refresh error; hover prefetch has no surface to report it.
  } finally {
    prefetches.delete(key);
  }
}
