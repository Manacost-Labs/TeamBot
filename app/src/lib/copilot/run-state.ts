/**
 * The client-side lifecycle of one logical request.
 *
 * A logical request may contain more than one AG-UI run when a browser tool is involved. The
 * reducer therefore describes the request rather than mirroring `agent.isRunning`: it stays active
 * until the promise returned by `runAgent` settles, while individual protocol events only move it
 * through the visible phase. Keeping this as a pure reducer makes reconnect and missed-final-event
 * behaviour deterministic and cheap to test without mounting the whole chat.
 */

export const AGENT_RUN_STATUSES = [
  "sending",
  "accepted",
  "queued",
  "starting",
  "thinking",
  "using_tool",
  "generating",
  "reconnecting",
  "completed",
  "failed",
  "cancelled",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export type AgentRunState = {
  status: AgentRunStatus;
  runId: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  finishedAt: number | null;
  elapsedMs: number;
  reconnectCount: number;
  toolName: string | null;
  hasAssistantOutput: boolean;
  error: string | null;
};

export type AgentRunAction =
  | { type: "send_started"; at: number; runId?: string }
  | { type: "accepted"; at: number; runId?: string }
  | { type: "queued"; at: number }
  | { type: "run_initialized"; at: number; runId?: string }
  | { type: "run_started"; at: number; runId?: string }
  | { type: "reasoning"; at: number }
  | { type: "tool_started"; at: number; name?: string }
  | { type: "tool_finished"; at: number }
  | { type: "text_started"; at: number }
  | { type: "text_delta"; at: number }
  | { type: "reconnecting"; at: number }
  | { type: "reconnected"; at: number }
  | { type: "finished"; at: number }
  | { type: "reconciled"; at: number; hasAssistantOutput: boolean }
  | { type: "failed"; at: number; error: string }
  | { type: "cancelled"; at: number };

export const initialAgentRunState: AgentRunState = {
  status: "completed",
  runId: null,
  startedAt: null,
  updatedAt: null,
  finishedAt: null,
  elapsedMs: 0,
  reconnectCount: 0,
  toolName: null,
  hasAssistantOutput: false,
  error: null,
};

export function isAgentRunActive(status: AgentRunStatus): boolean {
  return !["completed", "failed", "cancelled"].includes(status);
}

export function isAgentRunTerminal(status: AgentRunStatus): boolean {
  return !isAgentRunActive(status);
}

function timestamp(state: AgentRunState, at: number): number {
  return Math.max(state.updatedAt ?? at, at);
}

function startIfNeeded(
  state: AgentRunState,
  at: number,
  runId?: string,
): Pick<AgentRunState, "startedAt" | "runId"> {
  return {
    startedAt: state.startedAt ?? at,
    runId: runId ?? state.runId,
  };
}

function elapsed(state: AgentRunState, at: number): number {
  return state.startedAt === null
    ? state.elapsedMs
    : Math.max(state.elapsedMs, Math.max(0, at - state.startedAt));
}

/** Apply one local or AG-UI lifecycle fact without mutating the previous state. */
export function reduceAgentRun(
  state: AgentRunState,
  action: AgentRunAction,
): AgentRunState {
  // A terminal state belongs to the previous request. Start a fresh clock for the next one.
  const current =
    [
      "send_started",
      "accepted",
      "queued",
      "run_initialized",
      "run_started",
    ].includes(action.type) && isAgentRunTerminal(state.status)
      ? initialAgentRunState
      : state;
  const at = timestamp(current, action.at);

  switch (action.type) {
    case "send_started":
    case "accepted":
    case "queued":
    case "run_initialized":
    case "run_started": {
      const phase =
        action.type === "send_started"
          ? "sending"
          : action.type === "accepted"
            ? "accepted"
            : action.type === "queued"
              ? "queued"
              : action.type === "run_initialized"
                ? "starting"
                : "thinking";
      const started =
        action.type === "send_started" || action.type === "accepted"
          ? current.startedAt
            ? { startedAt: current.startedAt, runId: action.runId ?? current.runId }
            : { startedAt: action.at, runId: action.runId ?? current.runId }
          : startIfNeeded(current, at, "runId" in action ? action.runId : undefined);
      return {
        ...current,
        status: phase,
        ...started,
        updatedAt: at,
        finishedAt: null,
        error: null,
        elapsedMs: elapsed({ ...current, ...started }, at),
      };
    }
    case "reasoning":
      return {
        ...state,
        status: "thinking",
        ...startIfNeeded(current, at),
        updatedAt: at,
        finishedAt: null,
        error: null,
        elapsedMs: elapsed(current, at),
      };
    case "tool_started":
      return {
        ...state,
        status: "using_tool",
        ...startIfNeeded(current, at),
        updatedAt: at,
        finishedAt: null,
        toolName: action.name ?? null,
        error: null,
        elapsedMs: elapsed(current, at),
      };
    case "tool_finished":
      return {
        ...state,
        status: "thinking",
        updatedAt: at,
        toolName: null,
        error: null,
        elapsedMs: elapsed(state, at),
      };
    case "text_started":
    case "text_delta":
      return {
        ...state,
        status: "generating",
        ...startIfNeeded(current, at),
        updatedAt: at,
        finishedAt: null,
        hasAssistantOutput: true,
        error: null,
        elapsedMs: elapsed(current, at),
      };
    case "reconnecting":
      return {
        ...state,
        status: "reconnecting",
        updatedAt: at,
        reconnectCount: state.reconnectCount + 1,
        error: null,
        elapsedMs: elapsed(state, at),
      };
    case "reconnected":
      return {
        ...state,
        status: state.hasAssistantOutput ? "generating" : "thinking",
        updatedAt: at,
        error: null,
        elapsedMs: elapsed(state, at),
      };
    case "finished":
      return {
        ...state,
        status: "completed",
        updatedAt: at,
        finishedAt: at,
        toolName: null,
        error: null,
        elapsedMs: elapsed(state, at),
      };
    case "reconciled":
      return {
        ...state,
        status: action.hasAssistantOutput ? "completed" : state.status,
        updatedAt: at,
        finishedAt: action.hasAssistantOutput ? at : state.finishedAt,
        hasAssistantOutput: state.hasAssistantOutput || action.hasAssistantOutput,
        elapsedMs: elapsed(state, at),
      };
    case "failed":
      return {
        ...state,
        status: "failed",
        updatedAt: at,
        finishedAt: at,
        toolName: null,
        error: action.error,
        elapsedMs: elapsed(state, at),
      };
    case "cancelled":
      return {
        ...state,
        status: "cancelled",
        updatedAt: at,
        finishedAt: at,
        toolName: null,
        error: null,
        elapsedMs: elapsed(state, at),
      };
  }
}

export function agentRunStatusLabel(status: AgentRunStatus): string {
  switch (status) {
    case "sending":
      return "Отправляет запрос";
    case "accepted":
      return "Запрос принят";
    case "queued":
      return "В очереди";
    case "starting":
      return "Запускает сотрудника";
    case "thinking":
      return "Анализирует задачу";
    case "using_tool":
      return "Выполняет инструмент";
    case "generating":
      return "Формирует ответ";
    case "reconnecting":
      return "Восстанавливает соединение";
    case "completed":
      return "Ответ готов";
    case "failed":
      return "Не удалось завершить";
    case "cancelled":
      return "Остановлено";
  }
}

export function formatElapsedMs(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}:${seconds.toString().padStart(2, "0")}`
    : `${seconds} с`;
}
