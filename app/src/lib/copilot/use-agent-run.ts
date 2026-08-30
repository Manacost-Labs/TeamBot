import type { useAgent as useAgentHook } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type AgentRunScope,
  type AgentRunToken,
  agentRunActivityStore,
  useAgentRunActivity,
} from "./run-activity-store";
import { type AgentRunAction, initialAgentRunState } from "./run-state";

type AgentLike = ReturnType<typeof useAgentHook>["agent"];
type AgentRunDispatch = AgentRunAction extends infer Action
  ? Action extends { at: number }
    ? Omit<Action, "at">
    : never
  : never;

type UseAgentRunOptions = {
  scope: AgentRunScope;
  /** Packaged chat has no local send boundary, so its first protocol event explicitly starts a run. */
  implicitBegin?: boolean;
  /** Channel conversations finish after the logical `runAgent` promise, not every browser-tool run. */
  finishOnRunFinished?: boolean;
  /** Lets a channel try a bounded reconnect before presenting a transport failure. */
  onRunFailed?: (error: Error) => void;
};

/** Translate AG-UI callbacks into the global generation-aware lifecycle store. */
export function useAgentRun(agent: AgentLike, options: UseAgentRunOptions) {
  const { channelId, agentId } = options.scope;
  const scope = useMemo(() => ({ channelId, agentId }), [channelId, agentId]);
  const record = useAgentRunActivity(scope);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const transition = useCallback(
    (
      action: AgentRunDispatch,
      token?: AgentRunToken,
      protocolRunId?: string,
    ) => {
      agentRunActivityStore.transition(
        scope,
        { ...action, at: Date.now() } as AgentRunAction,
        {
          ...(token ? { token } : {}),
          ...(protocolRunId ? { protocolRunId } : {}),
        },
      );
    },
    [scope],
  );

  useEffect(() => {
    const ensureProtocolRun = (
      protocolRunId: string | undefined,
      inputMessages: ReadonlyArray<Readonly<{ id: string }>>,
    ) => {
      let token =
        optionsRef.current.implicitBegin === false
          ? agentRunActivityStore.getCurrentTokenForInput(scope, inputMessages)
          : agentRunActivityStore.getCurrentToken(scope);
      const current = agentRunActivityStore.getSnapshot(scope);
      // Channel runs begin at the user turn. If an older run initializes after a newer send, its
      // input does not contain the newer logical message id and must never acquire that generation.
      if (
        current?.logicalRunId &&
        isActive(current.state.status) &&
        optionsRef.current.implicitBegin === false &&
        token === null
      ) {
        return null;
      }
      if (
        (!current ||
          current.state.startedAt === null ||
          !isActive(current.state.status)) &&
        optionsRef.current.implicitBegin !== false
      ) {
        token = agentRunActivityStore.begin(scope, {
          logicalRunId: protocolRunId ?? `protocol:${Date.now()}`,
        });
      }
      return token;
    };
    const subscription = agent.subscribe?.({
      onRunInitialized: ({ input }) => {
        const token = ensureProtocolRun(input.runId, input.messages);
        if (!token) return;
        transition(
          {
            type: "run_initialized",
            ...(input.runId ? { runId: input.runId } : {}),
          },
          token,
          input.runId,
        );
      },
      onRunStartedEvent: ({ event, input }) => {
        const token = ensureProtocolRun(event.runId, input.messages);
        if (!token) return;
        transition(
          { type: "run_started", runId: event.runId },
          token,
          event.runId,
        );
      },
      onReasoningStartEvent: ({ input }) =>
        transition({ type: "reasoning" }, undefined, input.runId),
      onReasoningMessageStartEvent: ({ input }) =>
        transition({ type: "reasoning" }, undefined, input.runId),
      onToolCallStartEvent: ({ event, input }) =>
        transition(
          { type: "tool_started", name: event.toolCallName },
          undefined,
          input.runId,
        ),
      onToolCallEndEvent: ({ input }) =>
        transition({ type: "tool_finished" }, undefined, input.runId),
      onToolCallResultEvent: ({ input }) =>
        transition({ type: "tool_finished" }, undefined, input.runId),
      onTextMessageStartEvent: ({ input }) =>
        transition({ type: "text_started" }, undefined, input.runId),
      onRunFinishedEvent: ({ input }) => {
        if (optionsRef.current.finishOnRunFinished !== false) {
          transition({ type: "finished" }, undefined, input.runId);
        }
      },
      onRunErrorEvent: ({ event, input }) =>
        transition(
          {
            type: "failed",
            error:
              event.message?.trim() || "Сотрудник завершил работу с ошибкой.",
          },
          undefined,
          input.runId,
        ),
      onRunFailed: ({ error, input }) => {
        const handler = optionsRef.current.onRunFailed;
        if (handler) handler(error);
        else
          transition(
            { type: "failed", error: error.message },
            undefined,
            input.runId,
          );
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, scope, transition]);

  return {
    state: record?.state ?? initialAgentRunState,
    record,
    begin: useCallback(
      (logicalRunId: string) =>
        agentRunActivityStore.begin(scope, { logicalRunId }),
      [scope],
    ),
    accept: useCallback(
      (token?: AgentRunToken) => transition({ type: "accepted" }, token),
      [transition],
    ),
    queue: useCallback(
      (token?: AgentRunToken) => transition({ type: "queued" }, token),
      [transition],
    ),
    finish: useCallback(
      (token?: AgentRunToken) => transition({ type: "finished" }, token),
      [transition],
    ),
    fail: useCallback(
      (error: string, token?: AgentRunToken) =>
        transition({ type: "failed", error }, token),
      [transition],
    ),
    cancel: useCallback(
      (token?: AgentRunToken) => transition({ type: "cancelled" }, token),
      [transition],
    ),
    reconnecting: useCallback(
      (token?: AgentRunToken) => transition({ type: "reconnecting" }, token),
      [transition],
    ),
    reconnected: useCallback(
      (token?: AgentRunToken) => transition({ type: "reconnected" }, token),
      [transition],
    ),
    reconcile: useCallback(
      (
        hasAssistantOutput: boolean,
        runtimeActive: boolean,
        token?: AgentRunToken,
      ) =>
        agentRunActivityStore.reconcile(scope, {
          hasAssistantOutput,
          runtimeActive,
          ...(token ? { token } : {}),
        }),
      [scope],
    ),
  };
}

function isActive(status: string): boolean {
  return !["completed", "failed", "cancelled"].includes(status);
}
