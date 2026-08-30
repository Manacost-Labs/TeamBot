import type { useAgent as useAgentHook } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  initialAgentRunState,
  reduceAgentRun,
  type AgentRunAction,
  type AgentRunState,
} from "./run-state";

type AgentLike = ReturnType<typeof useAgentHook>["agent"];
type AgentRunDispatch = AgentRunAction extends infer Action
  ? Action extends { at: number }
    ? Omit<Action, "at">
    : never
  : never;

type UseAgentRunOptions = {
  /** Channel conversations finish after the logical `runAgent` promise, not every browser-tool run. */
  finishOnRunFinished?: boolean;
  /** Lets a channel try a bounded reconnect before presenting a transport failure. */
  onRunFailed?: (error: Error) => void;
};

/**
 * Translate AG-UI lifecycle callbacks into one small state stream for the activity panel.
 *
 * `onMessagesChanged` remains responsible for the transcript. This hook only consumes lifecycle and
 * per-event callbacks, so a token changes one memoised message row but does not rebuild the status
 * machine or start another timer.
 */
export function useAgentRun(
  agent: AgentLike,
  options: UseAgentRunOptions = {},
): {
  state: AgentRunState;
  begin: (runId?: string) => void;
  accept: (runId?: string) => void;
  queue: () => void;
  finish: () => void;
  fail: (error: string) => void;
  cancel: () => void;
  reconnecting: () => void;
  reconnected: () => void;
  reconcile: (hasAssistantOutput: boolean) => void;
} {
  const [state, dispatch] = useReducer(
    reduceAgentRun,
    initialAgentRunState,
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const send = useCallback(
    (action: AgentRunDispatch) => {
      dispatch({ ...action, at: Date.now() } as AgentRunAction);
    },
    [],
  );

  useEffect(() => {
    const subscription = agent.subscribe?.({
      onRunInitialized: ({ input }) => {
        send({
          type: "run_initialized",
          ...(input.runId ? { runId: input.runId } : {}),
        });
      },
      onRunStartedEvent: ({ event }) => {
        send({ type: "run_started", runId: event.runId });
      },
      onReasoningStartEvent: () => send({ type: "reasoning" }),
      onReasoningMessageStartEvent: () => send({ type: "reasoning" }),
      onToolCallStartEvent: ({ event }) =>
        send({ type: "tool_started", name: event.toolCallName }),
      onToolCallEndEvent: () => send({ type: "tool_finished" }),
      onToolCallResultEvent: () => send({ type: "tool_finished" }),
      onTextMessageStartEvent: () => send({ type: "text_started" }),
      onRunFinishedEvent: () => {
        if (optionsRef.current.finishOnRunFinished !== false) {
          send({ type: "finished" });
        }
      },
      onRunErrorEvent: ({ event }) =>
        send({
          type: "failed",
          error: event.message?.trim() || "Сотрудник завершил работу с ошибкой.",
        }),
      onRunFailed: ({ error }) => {
        const handler = optionsRef.current.onRunFailed;
        if (handler) handler(error);
        else send({ type: "failed", error: error.message });
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, send]);

  return {
    state,
    begin: useCallback(
      (runId?: string) => send({ type: "send_started", ...(runId ? { runId } : {}) }),
      [send],
    ),
    accept: useCallback(
      (runId?: string) => send({ type: "accepted", ...(runId ? { runId } : {}) }),
      [send],
    ),
    queue: useCallback(() => send({ type: "queued" }), [send]),
    finish: useCallback(() => send({ type: "finished" }), [send]),
    fail: useCallback((error: string) => send({ type: "failed", error }), [send]),
    cancel: useCallback(() => send({ type: "cancelled" }), [send]),
    reconnecting: useCallback(() => send({ type: "reconnecting" }), [send]),
    reconnected: useCallback(() => send({ type: "reconnected" }), [send]),
    reconcile: useCallback(
      (hasAssistantOutput: boolean) =>
        send({ type: "reconciled", hasAssistantOutput }),
      [send],
    ),
  };
}
