import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  AGENT_RUN_STATUSES,
  type AgentRunAction,
  type AgentRunState,
  initialAgentRunState,
  isAgentRunActive,
  reduceAgentRun,
} from "./run-state";

type Listener = () => void;

export type AgentRunScope = {
  channelId: string;
  agentId: string;
};

export type AgentRunToken = {
  key: string;
  generation: number;
  logicalRunId: string;
};

export type AgentAvailability = {
  /** Whether the channel still accepts messages. Null until a channel surface reports it. */
  channelAvailable: boolean | null;
  /** Whether CopilotKit currently has the runtime agent mounted and ready. */
  runtimeReady: boolean;
  updatedAt: number | null;
};

export type AgentRunRecord = {
  channelId: string;
  agentId: string;
  /** The user turn/request. Protocol runs spawned around browser tools remain inside this id. */
  logicalRunId: string | null;
  generation: number;
  /** Protocol run ids observed for the current logical generation. */
  protocolRunIds: readonly string[];
  state: AgentRunState;
  availability: AgentAvailability;
  /** True only for an active record restored from sessionStorage. */
  needsReconciliation: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type StoreOptions = {
  storage?: StorageLike;
  maxRecords?: number;
  now?: () => number;
};

type TransitionOptions = {
  token?: AgentRunToken;
  protocolRunId?: string;
};

const DEFAULT_AVAILABILITY: AgentAvailability = {
  channelAvailable: null,
  runtimeReady: false,
  updatedAt: null,
};
const STORAGE_PREFIX = "openbot:agent-runs:v2:";
const DEFAULT_MAX_RECORDS = 32;

function scopeKey(scope: AgentRunScope): string {
  return `${encodeURIComponent(scope.channelId)}:${encodeURIComponent(scope.agentId)}`;
}

function storageKey(sessionScope: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionScope)}`;
}

function unchangedAvailability(
  left: AgentAvailability,
  right: AgentAvailability,
): boolean {
  return (
    left.channelAvailable === right.channelAvailable &&
    left.runtimeReady === right.runtimeReady &&
    left.updatedAt === right.updatedAt
  );
}

/** Global lifecycle state with explicit logical generations and user-scoped minimal persistence. */
export class AgentRunActivityStore {
  private readonly records = new Map<string, AgentRunRecord>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly protocolOwners = new Map<string, Map<string, number>>();
  private readonly storage: StorageLike | undefined;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private sessionScope: string | null = null;

  constructor(options: StoreOptions = {}) {
    this.storage = options.storage;
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
    this.now = options.now ?? Date.now;
  }

  begin(
    scope: AgentRunScope,
    { at = this.now(), logicalRunId }: { at?: number; logicalRunId: string },
  ): AgentRunToken {
    const key = scopeKey(scope);
    const previous = this.records.get(key);
    const generation = (previous?.generation ?? 0) + 1;
    const state = reduceAgentRun(initialAgentRunState, {
      type: "send_started",
      at,
    });
    const record: AgentRunRecord = {
      ...scope,
      logicalRunId,
      generation,
      protocolRunIds: [],
      state,
      availability: previous?.availability ?? DEFAULT_AVAILABILITY,
      needsReconciliation: false,
    };
    this.records.set(key, record);
    // Protocol ids belong to one logical generation. A later generation starts with a clean
    // ownership table: its input-message check rejects a late boundary from the previous turn,
    // while non-boundary callbacks whose owner is no longer known are ignored below.
    this.protocolOwners.delete(key);
    this.trimRecords(key);
    this.persist();
    this.notify(key);
    return { key, generation, logicalRunId };
  }

  getCurrentToken(scope: AgentRunScope): AgentRunToken | null {
    const record = this.records.get(scopeKey(scope));
    if (!record?.logicalRunId) return null;
    return {
      key: scopeKey(scope),
      generation: record.generation,
      logicalRunId: record.logicalRunId,
    };
  }

  /** Resolve the current generation only when this protocol input contains its logical user turn. */
  getCurrentTokenForInput(
    scope: AgentRunScope,
    messages: ReadonlyArray<Readonly<{ id: string }>>,
  ): AgentRunToken | null {
    const token = this.getCurrentToken(scope);
    return token &&
      messages.some((message) => message.id === token.logicalRunId)
      ? token
      : null;
  }

  transition(
    scope: AgentRunScope,
    action: AgentRunAction,
    options: TransitionOptions = {},
  ): AgentRunRecord | null {
    const key = scopeKey(scope);
    const current = this.records.get(key);
    if (!current || !this.matches(current, key, options.token))
      return current ?? null;

    let protocolRunIds = current.protocolRunIds;
    if (options.protocolRunId) {
      const owners = this.protocolOwners.get(key) ?? new Map<string, number>();
      const owner = owners.get(options.protocolRunId);
      if (owner !== undefined && owner !== current.generation) return current;
      if (owner === undefined) {
        // Only a protocol boundary may attach a new protocol run to this logical request. A late
        // content callback whose owner has never been observed must not mutate whichever newer
        // logical generation happens to be current.
        if (
          !isAgentRunActive(current.state.status) ||
          (action.type !== "run_initialized" && action.type !== "run_started")
        )
          return current;
        owners.set(options.protocolRunId, current.generation);
        protocolRunIds = [
          ...current.protocolRunIds,
          options.protocolRunId,
        ].slice(-12);
        const retained = new Set(protocolRunIds);
        for (const runId of owners.keys()) {
          if (!retained.has(runId)) owners.delete(runId);
        }
        this.protocolOwners.set(key, owners);
      }
    }

    const state = reduceAgentRun(current.state, action);
    if (state === current.state && protocolRunIds === current.protocolRunIds)
      return current;
    const next: AgentRunRecord = {
      ...current,
      protocolRunIds,
      state,
      needsReconciliation: false,
    };
    this.records.set(key, next);
    this.persist();
    this.notify(key);
    return next;
  }

  reconcile(
    scope: AgentRunScope,
    {
      at = this.now(),
      hasAssistantOutput,
      runtimeActive,
      token,
      error = "Предыдущий запуск завершился без подтверждённого результата.",
    }: {
      at?: number;
      hasAssistantOutput: boolean;
      runtimeActive: boolean;
      token?: AgentRunToken;
      error?: string;
    },
  ): AgentRunRecord | null {
    const key = scopeKey(scope);
    const current = this.records.get(key);
    if (!current || !this.matches(current, key, token)) return current ?? null;
    if (!isAgentRunActive(current.state.status)) return current;

    const state = reduceAgentRun(
      current.state,
      hasAssistantOutput
        ? { type: "reconciled", at, hasAssistantOutput: true }
        : runtimeActive
          ? { type: "reconnected", at }
          : { type: "failed", at, error },
    );
    // A restored run that is still active needs continued server-authoritative monitoring. The
    // browser that created its runAgent promise no longer exists after a hard refresh, so clearing
    // this flag on the first positive lock check would leave the row active forever.
    const next = {
      ...current,
      state,
      needsReconciliation:
        runtimeActive && !hasAssistantOutput
          ? current.needsReconciliation
          : false,
    };
    this.records.set(key, next);
    this.persist();
    this.notify(key);
    return next;
  }

  setAvailability(
    scope: AgentRunScope,
    {
      at = this.now(),
      channelAvailable,
      runtimeReady,
    }: {
      at?: number;
      channelAvailable: boolean | null;
      runtimeReady: boolean;
    },
  ): void {
    const key = scopeKey(scope);
    const current = this.records.get(key) ?? {
      ...scope,
      logicalRunId: null,
      generation: 0,
      protocolRunIds: [],
      state: initialAgentRunState,
      availability: DEFAULT_AVAILABILITY,
      needsReconciliation: false,
    };
    const availability = { channelAvailable, runtimeReady, updatedAt: at };
    if (unchangedAvailability(current.availability, availability)) return;
    this.records.set(key, { ...current, availability });
    this.trimRecords(key);
    this.persist();
    this.notify(key);
  }

  getSnapshot(scope: AgentRunScope): AgentRunRecord | null {
    return this.records.get(scopeKey(scope)) ?? null;
  }

  getRecordsNeedingReconciliation(): readonly AgentRunRecord[] {
    return [...this.records.values()].filter(
      (record) =>
        record.needsReconciliation && isAgentRunActive(record.state.status),
    );
  }

  /** Keep uncertainty visible when neither server authority nor durable history could be read. */
  markReconciliationPending(
    scope: AgentRunScope,
    token?: AgentRunToken,
  ): AgentRunRecord | null {
    const key = scopeKey(scope);
    const current = this.records.get(key);
    if (!current || !this.matches(current, key, token)) return current ?? null;
    if (
      !current.needsReconciliation ||
      !isAgentRunActive(current.state.status)
    ) {
      return current;
    }
    const state = reduceAgentRun(current.state, {
      type: "reconnecting",
      at: this.now(),
    });
    const next = { ...current, state, needsReconciliation: true };
    this.records.set(key, next);
    this.persist();
    this.notify(key);
    return next;
  }

  subscribe(scope: AgentRunScope, listener: Listener): () => void {
    const key = scopeKey(scope);
    const keyListeners = this.listeners.get(key) ?? new Set<Listener>();
    keyListeners.add(listener);
    this.listeners.set(key, keyListeners);
    return () => {
      keyListeners.delete(listener);
      if (keyListeners.size === 0) this.listeners.delete(key);
    };
  }

  setSessionScope(sessionScope: string): void {
    if (this.sessionScope === sessionScope) return;
    // A child surface can report availability before the app shell's effect establishes the
    // authenticated scope. Preserve that in-memory observation on the first scope assignment;
    // later user changes still start from an entirely separate snapshot.
    const unscopedRecords =
      this.sessionScope === null ? new Map(this.records) : undefined;
    const changed = new Set(this.records.keys());
    this.records.clear();
    this.protocolOwners.clear();
    this.sessionScope = sessionScope;
    this.hydrate();
    if (unscopedRecords) {
      for (const [key, record] of unscopedRecords) {
        const hydrated = this.records.get(key);
        this.records.set(
          key,
          record.state.startedAt !== null || !hydrated
            ? record
            : { ...hydrated, availability: record.availability },
        );
      }
      this.persist();
    }
    for (const key of this.records.keys()) changed.add(key);
    changed.forEach((key) => {
      this.notify(key);
    });
  }

  clearSessionScope(sessionScope: string): void {
    try {
      this.storage?.removeItem(storageKey(sessionScope));
    } catch {
      // Storage privacy/quota failures never block sign-out.
    }
    if (this.sessionScope !== sessionScope) return;
    const changed = [...this.records.keys()];
    this.records.clear();
    this.protocolOwners.clear();
    this.sessionScope = null;
    changed.forEach((key) => {
      this.notify(key);
    });
  }

  private matches(
    record: AgentRunRecord,
    key: string,
    token: AgentRunToken | undefined,
  ): boolean {
    return (
      token === undefined ||
      (token.key === key &&
        token.generation === record.generation &&
        token.logicalRunId === record.logicalRunId)
    );
  }

  private notify(key: string): void {
    this.listeners.get(key)?.forEach((listener) => {
      listener();
    });
  }

  private trimRecords(protectedKey: string): void {
    while (this.records.size > this.maxRecords) {
      const oldest = [...this.records.entries()]
        .filter(([key]) => key !== protectedKey && !this.listeners.has(key))
        .sort(
          ([, left], [, right]) =>
            (left.state.updatedAt ?? 0) - (right.state.updatedAt ?? 0),
        )[0]?.[0];
      if (!oldest) break;
      this.records.delete(oldest);
      this.protocolOwners.delete(oldest);
    }
  }

  private persist(): void {
    if (!this.storage || !this.sessionScope) return;
    const records = [...this.records.values()]
      .filter((record) => record.state.startedAt !== null)
      .map((record) => ({
        channelId: record.channelId,
        agentId: record.agentId,
        logicalRunId: record.logicalRunId,
        generation: record.generation,
        state: {
          status: record.state.status,
          runId: record.state.runId,
          startedAt: record.state.startedAt,
          updatedAt: record.state.updatedAt,
          finishedAt: record.state.finishedAt,
          elapsedMs: record.state.elapsedMs,
          reconnectCount: record.state.reconnectCount,
          hasAssistantOutput: record.state.hasAssistantOutput,
        },
        availability: record.availability,
      }));
    try {
      this.storage.setItem(
        storageKey(this.sessionScope),
        JSON.stringify({ version: 2, records }),
      );
    } catch {
      // Runtime state remains correct in memory when storage is unavailable or full.
    }
  }

  private hydrate(): void {
    if (!this.storage || !this.sessionScope) return;
    try {
      const raw = this.storage.getItem(storageKey(this.sessionScope));
      const parsed = raw ? (JSON.parse(raw) as { records?: unknown }) : null;
      if (!parsed || !Array.isArray(parsed.records)) return;
      for (const candidate of parsed.records.slice(-this.maxRecords)) {
        const record = hydratedRecord(candidate);
        if (record) this.records.set(scopeKey(record), record);
      }
    } catch {
      // A malformed/blocked old session snapshot is treated as no recovery metadata.
    }
  }
}

function hydratedRecord(candidate: unknown): AgentRunRecord | null {
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  const state = value.state as Record<string, unknown> | undefined;
  const availability = value.availability as
    | Record<string, unknown>
    | undefined;
  if (
    typeof value.channelId !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.generation !== "number" ||
    (value.logicalRunId !== null && typeof value.logicalRunId !== "string") ||
    !state ||
    typeof state.status !== "string" ||
    !AGENT_RUN_STATUSES.includes(state.status as AgentRunState["status"])
  ) {
    return null;
  }
  const status = state.status as AgentRunState["status"];
  const numberOrNull = (input: unknown): number | null =>
    typeof input === "number" && Number.isFinite(input) ? input : null;
  const hydratedState: AgentRunState = {
    ...initialAgentRunState,
    status,
    runId: typeof state.runId === "string" ? state.runId : null,
    startedAt: numberOrNull(state.startedAt),
    updatedAt: numberOrNull(state.updatedAt),
    finishedAt: numberOrNull(state.finishedAt),
    elapsedMs: typeof state.elapsedMs === "number" ? state.elapsedMs : 0,
    reconnectCount:
      typeof state.reconnectCount === "number" ? state.reconnectCount : 0,
    hasAssistantOutput: state.hasAssistantOutput === true,
    // Content-bearing diagnostic details are deliberately not persisted.
    toolName: null,
    error: null,
  };
  return {
    channelId: value.channelId,
    agentId: value.agentId,
    logicalRunId: value.logicalRunId as string | null,
    generation: Math.max(0, Math.floor(value.generation)),
    protocolRunIds: [],
    state: hydratedState,
    availability: {
      channelAvailable:
        typeof availability?.channelAvailable === "boolean"
          ? availability.channelAvailable
          : null,
      runtimeReady: availability?.runtimeReady === true,
      updatedAt: numberOrNull(availability?.updatedAt),
    },
    needsReconciliation: isAgentRunActive(status),
  };
}

export function createAgentRunActivityStore(
  options: StoreOptions = {},
): AgentRunActivityStore {
  return new AgentRunActivityStore(options);
}

function availableBrowserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export const agentRunActivityStore = createAgentRunActivityStore({
  storage: availableBrowserStorage(),
});

export function setAgentRunSessionScope(sessionScope: string): void {
  agentRunActivityStore.setSessionScope(sessionScope);
}

export function clearAgentRunSessionScope(sessionScope: string): void {
  agentRunActivityStore.clearSessionScope(sessionScope);
}

export function useAgentRunActivity(
  scope: AgentRunScope,
  store: AgentRunActivityStore = agentRunActivityStore,
): AgentRunRecord | null {
  const { agentId, channelId } = scope;
  const stableScope = useMemo(
    () => ({ agentId, channelId }),
    [agentId, channelId],
  );
  const subscribe = useCallback(
    (listener: Listener) => store.subscribe(stableScope, listener),
    [stableScope, store],
  );
  const snapshot = useCallback(
    () => store.getSnapshot(stableScope),
    [stableScope, store],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
