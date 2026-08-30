import type { Message } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  seedMessage,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { recordChannelActivityMutationOptions } from "@/lib/channels/mutations";
import type { AgentChannel } from "@/lib/channels/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { createStableHistoryHydration } from "@/lib/copilot/history-hydration";
import { afterMs, joinWithin } from "@/lib/copilot/join-thread";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import {
  type AgentRunToken,
  agentRunActivityStore,
} from "@/lib/copilot/run-activity-store";
import {
  hasAssistantOutputAfter,
  RECONCILIATION_DELAYS_MS,
} from "@/lib/copilot/run-reconciliation";
import { isAgentRunActive } from "@/lib/copilot/run-state";
import { stoppedReason } from "@/lib/copilot/stopped-turn";
import {
  cachedThreadMessages,
  invalidateThreadMessagesCache,
  mergeAuthoritativeThreadMessages,
  mergeThreadMessagesById,
  refreshThreadMessages,
  type StoredThread,
} from "@/lib/copilot/thread-messages";
import { useAgentRun } from "@/lib/copilot/use-agent-run";
import {
  abandonAgentRunTiming,
  ensureAgentRunTiming,
  markAgentFirstTextPainted,
  markChannelTiming,
  scheduleAfterPaint,
} from "@/lib/performance/workspace-timing";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../lib/new-id";

/**
 * How long a stalled thread join is worth waiting for before it is ended.
 *
 * Ended, not outrun. See `lib/copilot/join-thread.ts` for what a connect left in flight does to the
 * next message sent.
 */
const JOIN_DEADLINE_MS = 1500;

/**
 * Backstop for a message typed before the runtime agent exists; it must not be discarded.
 */
const SEND_WITHOUT_RUNTIME_AFTER_MS = 1500;

/** A history request must not hold the first send gate indefinitely. */
const HISTORY_REFRESH_DEADLINE_MS = 4_000;

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|cancel|signal is aborted/i.test(message)) return false;
  return /network|fetch|socket|websocket|gateway|connection|timeout|timed out|econn|502|503|504/i.test(
    message,
  );
}

/**
 * One channel's conversation with one coworker.
 *
 * The local agent id is channel-scoped so two channels with the same coworker keep separate
 * durable threads.
 */
export function ChannelChat({
  channel,
  historyScope,
  runtimeAgentId,
}: {
  channel: AgentChannel;
  /** Authenticated user id; transcript cache entries never cross this scope. */
  historyScope: string;
  runtimeAgentId: string;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The core attaches the frontend tool registry; direct agent runs do not.
  const { copilotkit } = useCopilotKit();
  // Mentions are scoped to the channel's permitted agents.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const { agent, isReady } = useAgent({
    agentId: `channel:${channel.id}`,
    runtimeAgentId,
    threadId: channel.threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   */
  const [seed] = useState<Message | null>(() => {
    const pending = takeFirstMessage(channel.id);
    return pending ? seedMessage(pending.text, pending.id) : null;
  });

  /** Cleared by the send-on-mount effect without restarting it. */
  const seedRef = useRef(seed);
  seedRef.current = seed;

  /** Promise gate for ordering the first message after the thread join when possible. */
  const openJoinGate = useRef<() => void>(() => {});
  const joinGate = useRef<Promise<void> | null>(null);
  if (joinGate.current === null) {
    joinGate.current = new Promise<void>((resolve) => {
      openJoinGate.current = resolve;
    });
  }
  const joinGatePromise = joinGate.current;

  /** Promise gate so messages typed before runtime readiness wait instead of being discarded. */
  const openReadyGate = useRef<() => void>(() => {});
  const readyGate = useRef<Promise<void> | null>(null);
  if (readyGate.current === null) {
    readyGate.current = new Promise<void>((resolve) => {
      openReadyGate.current = resolve;
    });
  }
  const readyGatePromise = readyGate.current;
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;

  /*
   * THE AGENT IS READ WHEN IT IS USED, NEVER CAPTURED BEFORE A WAIT. `useAgent` hands back a
   * provisional agent until the proxied one is registered, and a different object afterwards. The
   * stale one still runs and still reaches the thread, so the answer is stored and shows up on the
   * next reload while the rendered agent sits empty. `say` waits, so it spans that swap.
   */
  const agentRef = useRef(agent);
  agentRef.current = agent;

  /**
   * One logical request may contain several protocol runs when a browser tool is involved. The
   * hook follows the visible phases, while this screen calls `finish` only after the whole
   * `runAgent` promise has settled.
   */
  const runActivity = useAgentRun(agent, {
    scope: { channelId: channel.id, agentId: runtimeAgentId },
    implicitBegin: false,
    finishOnRunFinished: false,
    // The delivery catch performs the bounded reconnect. Do not turn a transport error into a
    // terminal state before that recovery window has had a chance to attach again.
    onRunFailed: () => {},
  });

  useEffect(() => {
    agentRunActivityStore.setAvailability(
      { channelId: channel.id, agentId: runtimeAgentId },
      { channelAvailable: channel.active, runtimeReady: isReady },
    );
  }, [channel.active, channel.id, isReady, runtimeAgentId]);
  useEffect(
    () => () => {
      agentRunActivityStore.setAvailability(
        { channelId: channel.id, agentId: runtimeAgentId },
        { channelAvailable: channel.active, runtimeReady: false },
      );
    },
    [channel.active, channel.id, runtimeAgentId],
  );

  /** A message is drawn immediately, before readiness and thread join have completed. */
  const [optimisticMessages, setOptimisticMessages] = useState<
    readonly Message[]
  >([]);

  /**
   * History has been asked for and has not arrived. True for a channel opened from the roster, where
   * an empty transcript is also a real answer; false for one started from the compose screen, which
   * already has the message that started it.
   */
  const initialHistoryRef = useRef(
    cachedThreadMessages(historyScope, channel.threadId, runtimeAgentId),
  );
  const [restoring, setRestoring] = useState(
    seed === null && initialHistoryRef.current === null,
  );
  /**
   * History shown while the runtime join is still settling.
   *
   * It is deliberately not written into the agent until the join is over: a late connect replaces
   * `agent.messages`. Drawing this read-only preview removes that wait from first paint without
   * reopening the race that used to erase a message sent during a join.
   */
  const [historyPreview, setHistoryPreview] = useState<Message[]>(
    initialHistoryRef.current?.messages ?? [],
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  /**
   * How many stored turns this app could not read.
   *
   * Held rather than derived, because the transcript is the running agent's once history is handed
   * over: `agent.messages` is what was restored, and what was dropped on the way in is not
   * recoverable from it.
   */
  const [unreadable, setUnreadable] = useState(
    initialHistoryRef.current?.unreadable ?? 0,
  );
  const historyIdentity = `${historyScope}\u0000${channel.threadId}\u0000${runtimeAgentId}`;
  const historyHydrationState = useMemo(
    () => ({
      identity: historyIdentity,
      hydration: createStableHistoryHydration<StoredThread, typeof agent>(),
      localWriteStarted: false,
    }),
    // A channel identity gets one gate; an obsolete request remains isolated on the old instance.
    [historyIdentity],
  );
  const historyHydration = historyHydrationState.hydration;
  const [authoritativeHistoryIdentity, setAuthoritativeHistoryIdentity] =
    useState<string | null>(null);
  const historyIsAuthoritative =
    authoritativeHistoryIdentity === historyHydrationState.identity;
  const presentAuthoritativeHistory = useCallback(
    (stored: StoredThread) => {
      markChannelTiming(channel.id, "fresh_history_loaded");
      setHistoryPreview((preview) =>
        mergeThreadMessagesById(preview, stored.messages, {
          retainMissing: false,
        }),
      );
      setUnreadable(stored.unreadable);
      setHistoryError(null);
      setAuthoritativeHistoryIdentity(historyHydrationState.identity);
    },
    [channel.id, historyHydrationState.identity, historyHydrationState],
  );
  const pendingFirstTextPaint = useRef<string | null>(null);
  useEffect(
    () =>
      scheduleAfterPaint(() => {
        if (initialHistoryRef.current !== null) {
          markChannelTiming(channel.id, "cached_history_painted");
        }
        markChannelTiming(channel.id, "composer_ready");
      }),
    [channel.id],
  );
  useEffect(
    () => () => {
      const pending = pendingFirstTextPaint.current;
      if (pending) abandonAgentRunTiming(pending);
    },
    [],
  );
  useEffect(() => {
    if (isReady) {
      openReadyGate.current();
      markChannelTiming(channel.id, "runtime_ready");
    }
  }, [channel.id, isReady]);

  const historyAttempt = useRef(0);
  const joinAttempt = useRef(0);

  // Paint cached history immediately. The same bounded authoritative read gates the first send.
  useEffect(() => {
    const attempt = historyAttempt.current + 1;
    historyAttempt.current = attempt;
    let current = true;
    setHistoryError(null);

    void (async () => {
      const outcome = await historyHydration.ensureCurrentTarget(
        () => agentRef.current,
        () =>
          refreshThreadMessages(
            historyScope,
            channel.threadId,
            runtimeAgentId,
            {
              signal: AbortSignal.timeout(HISTORY_REFRESH_DEADLINE_MS),
            },
          ),
      );
      if (!current) return;
      if (outcome.status === "ready") {
        presentAuthoritativeHistory(outcome.value);
      } else {
        setHistoryError(
          outcome.error instanceof Error
            ? outcome.error.message
            : "Не удалось обновить историю диалога.",
        );
      }
      if (attempt === historyAttempt.current) {
        setRestoring(false);
      }
    })();

    return () => {
      current = false;
    };
  }, [
    channel.threadId,
    historyHydration,
    historyScope,
    presentAuthoritativeHistory,
    runtimeAgentId,
  ]);

  // Join independently. History already paints while CopilotKit is still preparing the agent.
  useEffect(() => {
    if (!isReady) return;
    const attempt = joinAttempt.current + 1;
    joinAttempt.current = attempt;
    let current = true;
    void (async () => {
      try {
        const outcome = await joinWithin({
          connect: copilotkit.connectAgent({ agent }),
          deadline: afterMs(JOIN_DEADLINE_MS),
          detach: () => agent.detachActiveRun(),
        });
        if (outcome === "connected" && current) {
          markChannelTiming(channel.id, "runtime_joined");
        }
      } finally {
        if (attempt === joinAttempt.current) {
          if (current) {
            setJoined(true);
          }
          openJoinGate.current();
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [agent, channel.id, copilotkit, isReady]);

  // A cached tail paints additively. A server revision replaces it, retaining only this tab's writes.
  useEffect(() => {
    historyHydration.observeTarget(agent);
    if (!joined || (!historyIsAuthoritative && historyPreview.length === 0)) {
      return;
    }
    const merged = historyIsAuthoritative
      ? mergeAuthoritativeThreadMessages(
          agent.messages,
          historyPreview,
          historyHydrationState.localWriteStarted,
        )
      : mergeThreadMessagesById(agent.messages, historyPreview);
    if (
      merged.length !== agent.messages.length ||
      merged.some((message, index) => message !== agent.messages[index])
    ) {
      agent.setMessages(merged as typeof agent.messages);
    }
  }, [
    agent,
    historyHydration,
    historyHydrationState,
    historyIsAuthoritative,
    historyPreview,
    joined,
  ]);

  // Tool calls from this conversation act on this coworker's own computer.
  useActiveBot(runtimeAgentId);

  const skillCommands = useSkillCommands(runtimeAgentId);

  // Run failures arrive as events and are reported only for turns started in this mount.
  const [runError, setRunError] = useState<string | null>(null);
  const awaitingReplies = useRef(new Set<number>());
  const isAwaiting = (token: AgentRunToken) =>
    awaitingReplies.current.has(token.generation);
  const isCurrentRun = (token: AgentRunToken) =>
    agentRunActivityStore.getCurrentToken({
      channelId: channel.id,
      agentId: runtimeAgentId,
    })?.generation === token.generation;
  const lastRequest = useRef<{
    text: string;
    skillInstructions: string[];
  } | null>(null);

  /*
   * TWO DIFFERENT FACTS ABOUT ONE TURN, AND NEITHER OF THEM IS `agent.isRunning`.
   *
   * `turnsInFlight` counts what a person would call the Bot having the turn: from the moment `say`
   * is entered until the whole thing has come back, browser actions in the middle included. It is
   * what decides whether the next thing typed is sent or parked, and what tells the queue its wait
   * is over.
   *
   * `runsInFlight` counts what Stop can actually reach: the run `copilotkit.runAgent` opens, and
   * nothing before it. A turn can be in flight for a second and a half before that, while `say`
   * waits for the runtime agent, and a Stop drawn in that window aborts a controller nobody has
   * made yet.
   *
   * `agent.isRunning` looks like both and is neither. It reports the run on the wire, and a turn
   * that touches the browser is several runs in a row: the Bot asks for a click, the run ENDS so
   * the browser can answer it, and another run starts carrying the answer. The agent reports itself
   * idle in every one of those gaps — the truth about the wire and a lie about the turn. OpenBot
   * registers every computer tool as a frontend tool, so the gaps open on ordinary work rather than
   * on some edge case, and anything keyed on the turn ending fires in the middle of one instead.
   *
   * Counters rather than booleans because nothing stops a second turn being started from a
   * component button while the first is still going, and two overlapping turns must not have the
   * first one to finish declare the conversation idle.
   */
  const [turnsInFlight, setTurnsInFlight] = useState(0);
  const [runsInFlight, setRunsInFlight] = useState(0);

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const report = (text: string, agentId: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    recordActivity.mutate({
      agentId,
      at: new Date().toISOString(),
      channelId: channel.id,
      text: trimmed,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  const reconcileThread = async (
    target: typeof agent,
    userMessageId: string,
    token: AgentRunToken,
  ): Promise<boolean> => {
    let refreshFailure: string | null = null;
    for (const delay of RECONCILIATION_DELAYS_MS) {
      if (delay > 0) await afterMs(delay);
      try {
        const stored = await refreshThreadMessages(
          historyScope,
          channel.threadId,
          runtimeAgentId,
          { signal: AbortSignal.timeout(HISTORY_REFRESH_DEADLINE_MS) },
        );
        refreshFailure = null;
        const merged = mergeThreadMessagesById(
          target.messages,
          stored.messages,
        );
        if (
          merged.length !== target.messages.length ||
          merged.some((message, index) => message !== target.messages[index])
        ) {
          target.setMessages(merged as typeof target.messages);
        }
        if (hasAssistantOutputAfter(merged, userMessageId)) {
          runActivity.reconcile(true, target.isRunning, token);
          if (mounted.current) setHistoryError(null);
          return true;
        }
      } catch (error) {
        refreshFailure =
          error instanceof Error
            ? error.message
            : "Не удалось обновить историю диалога.";
      }
    }
    if (refreshFailure && mounted.current) setHistoryError(refreshFailure);
    const hasAnswer = hasAssistantOutputAfter(target.messages, userMessageId);
    runActivity.reconcile(hasAnswer, target.isRunning, token);
    return hasAnswer;
  };

  const recoverTransport = async (
    target: typeof agent,
    error: unknown,
    userMessageId: string,
    token: AgentRunToken,
  ): Promise<boolean> => {
    if (!isAwaiting(token) || !isTransportFailure(error)) return false;
    runActivity.reconnecting(token);
    await afterMs(400);
    try {
      // Intelligence resumes the current thread from its last event cursor. This is bounded to one
      // attempt so a dead gateway cannot leave the composer locked forever.
      await copilotkit.connectAgent({ agent: target });
      if (!isAwaiting(token)) return false;
      const recovered = await reconcileThread(target, userMessageId, token);
      if (recovered) {
        awaitingReplies.current.delete(token.generation);
        runActivity.finish(token);
        const reply = [...target.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        const content = typeof reply?.content === "string" ? reply.content : "";
        if (content) reportRef.current(content, runtimeAgentId);
        return true;
      }
      runActivity.reconnected(token);
    } catch {
      // The caller presents the original transport reason below.
    }
    return false;
  };

  /**
   * Everything `say` does once it has something worth sending, split out so the counter it is
   * wrapped in covers every way out of here, a throw included.
   */
  const deliver = async (
    trimmed: string,
    skillInstructions: string[],
    userMessageId: string,
    token: AgentRunToken,
  ) => {
    // Wait briefly for the runtime agent instance before adding the message.
    if (!isReadyRef.current) {
      await Promise.race([
        readyGatePromise,
        afterMs(SEND_WITHOUT_RUNTIME_AFTER_MS),
      ]);
    }

    /*
     * EVERY TURN WAITS FOR THE JOIN, not just the first of a new channel: a message added while the
     * connect is in flight is erased by it either way. Unbounded only in appearance — the join
     * effect bounds itself and opens this gate from a `finally`. If that effect never ran there is
     * no runtime agent, and no connect in flight to wait on.
     */
    if (isReadyRef.current) {
      await joinGatePromise;
    }

    const hydrateCurrentTarget = () =>
      historyHydration.ensureCurrentTarget(
        () => agentRef.current,
        () =>
          refreshThreadMessages(
            historyScope,
            channel.threadId,
            runtimeAgentId,
            {
              signal: AbortSignal.timeout(HISTORY_REFRESH_DEADLINE_MS),
            },
          ),
      );
    let hydrated = await hydrateCurrentTarget();
    // The coordinator checks after its own await. Check once more in this continuation so even a
    // replacement queued between its resolution and ours forces a new refresh before the final
    // synchronous target capture below.
    while (agentRef.current !== hydrated.target) {
      hydrated = await hydrateCurrentTarget();
    }
    if (hydrated.status === "failed") {
      const detail =
        hydrated.error instanceof Error
          ? hydrated.error.message
          : "Не удалось обновить историю диалога.";
      const reason =
        "Сообщение не отправлено: полную историю диалога получить не удалось. " +
        "Это защищает ответ сотрудника от потери предыдущего контекста.";
      if (isCurrentRun(token)) {
        setHistoryError(detail);
        setRunError(reason);
      }
      setOptimisticMessages((messages) =>
        messages.filter((message) => message.id !== userMessageId),
      );
      runActivity.fail(reason, token);
      return;
    }
    // The coordinator re-checks agentRef after its final await. Everything from this capture through
    // addMessage is synchronous, so a replacement cannot move this turn back onto an obsolete agent.
    const target = hydrated.target;
    presentAuthoritativeHistory(hydrated.value);

    // Cached history may be only a bounded tail. The server revision replaces it, while IDs this
    // tab already wrote survive until persistence echoes them. Concurrent sends therefore share the
    // refresh without the later continuation erasing the earlier one's new row.
    const hydratedMessages = mergeAuthoritativeThreadMessages(
      target.messages,
      hydrated.value.messages,
      historyHydrationState.localWriteStarted,
    );
    if (
      hydratedMessages.length !== target.messages.length ||
      hydratedMessages.some(
        (message, index) => message !== target.messages[index],
      )
    ) {
      target.setMessages(hydratedMessages as typeof target.messages);
    }

    if (isCurrentRun(token)) setRunError(null);
    awaitingReplies.current.add(token.generation);

    /*
     * THE SKILL GOES IN FRONT OF THE MESSAGE, AS A SYSTEM TURN. A `/` chip is one token in the
     * composer; what it stands for is the instruction added here, ahead of what the person typed, so
     * the Bot reads the job before the request.
     *
     * A system message rather than text prepended to theirs, because the two are not the same kind
     * of thing: the transcript should show what a person said, and pasting the skill into their
     * words puts sentences in their mouth and makes the reply quote instructions back at them.
     *
     * `transcriptMessages` draws user and assistant turns, so this never appears on screen — the
     * chip is what says a skill was used, and it stays visible in the message they sent.
     */
    historyHydrationState.localWriteStarted = true;
    for (const instruction of skillInstructions) {
      const systemMessageId = newId();
      target.addMessage({
        content: instruction,
        id: systemMessageId,
        role: "system",
      });
    }

    target.addMessage({
      content: trimmed,
      id: userMessageId,
      role: "user",
    });
    invalidateThreadMessagesCache(
      historyScope,
      channel.threadId,
      runtimeAgentId,
    );
    report(trimmed, null);

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(target.messages);
    if (repaired !== target.messages) {
      target.setMessages(repaired as typeof target.messages);
    }

    runActivity.accept(token);
    setRunsInFlight((count) => count + 1);
    try {
      await copilotkit.runAgent({ agent: target });
      if (!isAwaiting(token)) return;

      /*
       * The final event and durable persistence are intentionally reconciled separately. If the
       * browser missed RUN_FINISHED, the platform history still gives us the answer; if both are
       * missing, this request is not allowed to masquerade as completed.
       */
      const hasAnswer = await reconcileThread(target, userMessageId, token);
      if (!hasAnswer) {
        const reason = "Сотрудник завершил работу без результата.";
        awaitingReplies.current.delete(token.generation);
        runActivity.fail(reason, token);
        if (mounted.current && isCurrentRun(token)) setRunError(reason);
        throw new Error(reason);
      }

      awaitingReplies.current.delete(token.generation);
      runActivity.finish(token);
      const reply = [...target.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      const content = typeof reply?.content === "string" ? reply.content : "";
      if (content) reportRef.current(content, runtimeAgentId);
    } catch (error) {
      const recovered = await recoverTransport(
        target,
        error,
        userMessageId,
        token,
      );
      if (recovered) return;
      if (isAwaiting(token)) {
        awaitingReplies.current.delete(token.generation);
        const reason = stoppedReason(error);
        runActivity.fail(reason, token);
        if (mounted.current && isCurrentRun(token)) setRunError(reason);
      }
      return;
    } finally {
      if (mounted.current) setRunsInFlight((count) => count - 1);
    }
  };

  /**
   * Send a user turn through the channel, including activity reporting and history repair.
   *
   * Every user turn in this channel goes through here — what the composer sends, the seed from the
   * compose screen, and a button inside a rendered component. That is what makes the counter worth
   * keeping here rather than in the view: the view sees only the turns it started itself, and a
   * queue that drains on the wrong one of those posts a correction into the middle of an answer.
   */
  const say = async (
    text: string,
    skillInstructions: string[] = [],
    suppliedMessageId?: string,
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    lastRequest.current = { text: trimmed, skillInstructions };
    setRunError(null);
    const userMessageId = suppliedMessageId ?? newId();
    // Component actions may overlap an active turn. Sample the first one rather than attributing
    // its answer to a later user row whose timing would otherwise overwrite this correlation.
    if (pendingFirstTextPaint.current === null) {
      ensureAgentRunTiming(userMessageId);
      pendingFirstTextPaint.current = userMessageId;
    }
    const token = runActivity.begin(userMessageId);
    setOptimisticMessages((messages) => [
      ...messages.filter((message) => message.id !== userMessageId),
      { content: trimmed, id: userMessageId, role: "user" },
    ]);
    setTurnsInFlight((count) => count + 1);
    try {
      await deliver(trimmed, skillInstructions, userMessageId, token);
    } finally {
      if (
        pendingFirstTextPaint.current === userMessageId &&
        !hasAssistantOutputAfter(agentRef.current.messages, userMessageId)
      ) {
        abandonAgentRunTiming(userMessageId);
        pendingFirstTextPaint.current = null;
      }
      if (mounted.current) setTurnsInFlight((count) => count - 1);
    }
  };

  useEffect(() => {
    const fail = (
      message: string,
      inputMessages: ReadonlyArray<Readonly<{ id: string }>>,
    ) => {
      const token = agentRunActivityStore.getCurrentTokenForInput(
        { channelId: channel.id, agentId: runtimeAgentId },
        inputMessages,
      );
      if (!token || !awaitingReplies.current.has(token.generation)) return;
      awaitingReplies.current.delete(token.generation);
      setRunError(message);
    };
    const subscription = agent.subscribe?.({
      // Both surfaces fall back to the same sentence, from the same place, so a person who uses
      // both is not told two different things about the same silence.
      onRunErrorEvent: ({ event, input }) =>
        fail(stoppedReason(event?.message), input.messages),
      // A finished protocol run is not necessarily the finished logical request: frontend tools can
      // start a follow-up run with their result. `deliver` owns the final transition.
      onRunFinishedEvent: () => {},
    });
    return () => subscription?.unsubscribe();
  }, [agent, channel.id, runtimeAgentId]);

  /** Keep the visible optimistic bubble until the server has echoed the same message id. */
  const messageCount = agent.messages.length;
  // AG-UI mutates this message array in place; the count is the change signal for this cleanup.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messageCount tracks the mutable AG-UI array.
  useEffect(() => {
    const ids = new Set(agent.messages.map((message) => message.id));
    if (ids.size === 0) return;
    setOptimisticMessages((messages) => {
      const next = messages.filter((message) => !ids.has(message.id));
      return next.length === messages.length ? messages : next;
    });
  }, [agent, messageCount]);

  /** Stable reference for effects and component callbacks. */
  const sayRef = useRef(say);
  sayRef.current = say;

  const retryLast = useCallback(() => {
    const request = lastRequest.current;
    if (!request || awaitingReplies.current.size > 0) return;
    void sayRef.current(request.text, request.skillInstructions);
  }, []);

  /**
   * Component buttons speak as user turns without forcing every transcript card to re-render.
   */
  const askFromComponent = useCallback((text: string) => {
    void sayRef.current(text);
  }, []);

  /**
   * Send the create-channel seed once. No waiting of its own: `say` owns that for every turn, and a
   * second copy of the ordering here was the one that could disagree with it.
   */
  useEffect(() => {
    const pending = seedRef.current;
    if (!pending) return;
    seedRef.current = null;

    void sayRef.current(
      typeof pending.content === "string" ? pending.content : "",
      [],
      pending.id,
    );

    // Keep `seed` in state; transcriptMessages gives it up once the agent holds a user turn.
  }, []);

  const currentMessages =
    agent.messages.length > 0 ? agent.messages : historyPreview;
  const messageIds = new Set(currentMessages.map((message) => message.id));
  const pendingMessages = optimisticMessages.filter(
    (message) => !messageIds.has(message.id),
  );
  const visibleMessages = transcriptMessages(
    [...currentMessages, ...pendingMessages],
    seed,
  );
  const pendingPaintMessageId = pendingFirstTextPaint.current;
  const firstTextPaintReady = pendingPaintMessageId
    ? hasAssistantOutputAfter(visibleMessages, pendingPaintMessageId)
    : false;
  useEffect(() => {
    if (!pendingPaintMessageId || !firstTextPaintReady) return;
    return scheduleAfterPaint(() => {
      markAgentFirstTextPainted(pendingPaintMessageId);
      if (pendingFirstTextPaint.current === pendingPaintMessageId) {
        pendingFirstTextPaint.current = null;
      }
    });
  }, [firstTextPaintReady, pendingPaintMessageId]);

  return (
    <ConversationProvider ask={askFromComponent}>
      <ConversationView
        agents={toAgentOptions(agentProfiles, channel.agentIds)}
        /*
         * THE TURN, not the run. `say` waits for the runtime agent and the join before a run starts,
         * and `agent.isRunning` alone leaves that gap unmarked — which is the one moment the
         * "Thinking" line exists for. Same value as `pending`, deliberately.
         */
        busy={
          agent.isRunning ||
          turnsInFlight > 0 ||
          (runActivity.state.startedAt !== null &&
            isAgentRunActive(runActivity.state.status))
        }
        // The `/` menu exposes only skills granted to this Bot.
        commands={skillCommands}
        conversationKey={channel.id}
        // Readiness is handled by `say`; deletion is the only disabled-chat state.
        disabled={!channel.active}
        messages={visibleMessages}
        notice={
          /*
           * Two things can be worth saying at once — a deleted coworker and a history with holes in
           * it — and they are independent, so neither is an `else` for the other.
           */
          <>
            {historyError ? (
              <p className="pb-2 text-sm text-destructive" role="alert">
                Не удалось обновить историю диалога: {historyError}
              </p>
            ) : null}
            {unreadable > 0 ? (
              <p className="pb-2 text-sm text-muted-foreground" role="status">
                {unreadable === 1
                  ? "Одно предыдущее сообщение не удалось прочитать."
                  : `${unreadable} предыдущих сообщений не удалось прочитать.`}{" "}
                Остальная часть диалога загружена полностью.
              </p>
            ) : null}
            {channel.active ? null : (
              <p className="pb-2 text-sm text-muted-foreground" role="status">
                Этот сотрудник удалён. Диалог доступен для чтения, но ответить
                сотрудник больше не сможет.
              </p>
            )}
          </>
        }
        onSubmit={async (draft) => {
          // `draft.agentId` carries the @mentioned coworker, but nothing routes on it yet: this
          // channel is pinned to one `runtimeAgentId` for the life of its thread, so honouring a
          // per-message mention is a change to that binding, not to the composer.
          //
          // `commandIds` are the `/` chips that survived into the send, in the order they were
          // typed. Resolved against the same list the menu was built from, so a chip left over from
          // a skill that has since been revoked resolves to nothing rather than to a stale
          // instruction — the menu is refetched, and this reads from it.
          const skillInstructions = draft.commandIds
            .map(
              (id) =>
                skillCommands.find((command) => command.id === id)?.prompt,
            )
            .filter((instruction): instruction is string =>
              Boolean(instruction),
            );

          await say(draft.text, skillInstructions);
        }}
        run={runActivity.state}
        /**
         * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
         * unanswered tool call before the next turn.
         */
        onStop={() => {
          const token = agentRunActivityStore.getCurrentToken({
            channelId: channel.id,
            agentId: runtimeAgentId,
          });
          if (token) {
            awaitingReplies.current.delete(token.generation);
            runActivity.cancel(token);
          }
          copilotkit.stopAgent({ agent });
        }}
        onQueued={runActivity.queue}
        onRetry={retryLast}
        /*
         * The turn, not the run. A browser action ends one run and starts another, and telling the
         * conversation it is idle in between is what would drain a parked correction into the
         * middle of an answer: a second turn racing the first on one thread, with a fabricated
         * result stitched over a tool call that is still executing.
         */
        pending={agent.isRunning || turnsInFlight > 0}
        /*
         * A channel outlives its turns, so it is the screen where waiting is worth offering. A
         * correction typed mid-answer is held here, in this tab, and runs as one follow-up turn the
         * moment this one is over — including when it is over because somebody pressed the button
         * above.
         */
        queueWhileBusy
        restoring={restoring}
        /*
         * The run, not the turn. Stop reaches a run through the core's abort controller, and that
         * controller does not exist until `say` has finished waiting for the runtime agent — so
         * this is the one place the narrower fact is the honest one to draw a button from.
         */
        stoppable={agent.isRunning || runsInFlight > 0}
        /*
         * At the END OF THE TRANSCRIPT rather than above the composer, which is where this used to
         * be. A turn that ends without an answer leaves a gap exactly where the reply was going to
         * appear, and the person is already looking at it; an explanation in the composer area is a
         * different part of the screen from the thing it explains.
         *
         * `runError` carries whatever ended the turn, in that thing's own words. A Bot that stopped
         * streaming says so, because the deployment's stall watchdog writes that sentence into the
         * run before closing it; see server/src/channels/stall-guard.ts.
         */
        stopped={runError ?? undefined}
      />
    </ConversationProvider>
  );
}
