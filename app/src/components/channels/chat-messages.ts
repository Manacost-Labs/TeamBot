import type { Message, ToolCall } from "@ag-ui/core";
import {
  parseArtifactToolResult,
  REMOTE_CREATE_ARTIFACT_TOOL_NAME,
} from "@/lib/artifacts/contract";
import {
  type AttachmentMessageReference,
  attachmentRefsFromContent,
  textFromMessageContent,
} from "@/lib/attachments/message-content";
import { isProgressNote } from "@/lib/copilot/run-reconciliation";
import {
  type AgentRunState,
  agentRunStatusLabel,
  isAgentRunActive,
} from "@/lib/copilot/run-state";

/**
 * Transcript projection that pairs assistant tool calls with later tool-result messages.
 */

export type VisibleChatItem =
  | {
      kind: "text";
      id: string;
      role: "user" | "assistant";
      text: string;
      attachments?: readonly AttachmentMessageReference[];
    }
  | { kind: "reasoning"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      toolCall: ToolCall;
      /** The result, once there is one. Absent means the call is still in flight. */
      result?: string;
    };

export type VisibleChatWindow = {
  items: readonly VisibleChatItem[];
  hidden: number;
};

export type TranscriptWindow = {
  items: readonly Exclude<VisibleChatItem, { kind: "reasoning" }>[];
  /** Renderable rows before this window. Reasoning and standalone tool results do not consume it. */
  hiddenBefore: number;
  /** Renderable rows after this window when the reader has navigated away from the live tail. */
  hiddenAfter: number;
  /** The first row of the next older page, or null once the beginning is visible. */
  olderStartId: string | null;
  /** Null means the requested cursor disappeared and the projection safely fell back to the tail. */
  resolvedStartId: string | null;
};

type TranscriptWindowOptions = {
  size: number;
  startId?: string | null;
  olderStep?: number;
};

export type ActivityStep = {
  id: string;
  label: string;
  state: "active" | "done" | "warning";
};

export type ActivitySnapshot = {
  label: string;
  status: "done" | "idle" | "incomplete" | "stopped" | "working";
  statusLabel: string;
  steps: readonly ActivityStep[];
  toolCount: number;
  runStatus?: AgentRunState["status"];
  elapsedMs: number;
};

/** Choose a plain-language phase for the small live activity indicator. */
function toolActivityLabel(
  tool: Extract<VisibleChatItem, { kind: "tool" }>,
): string {
  const hint =
    `${tool.toolCall.function.name} ${tool.toolCall.function.arguments}`.toLowerCase();
  if (/(fetch|read|open|inspect|verify)/.test(hint))
    return "Проверяет источник";
  if (/(search|reddit|x-search|tinyfish)/.test(hint)) return "Ищет источники";
  if (/(write|save|report|markdown)/.test(hint)) return "Сохраняет отчёт";
  return "Выполняет шаг исследования";
}

/** Choose a plain-language phase for the small live activity indicator. */
export function activityLabelFor(items: readonly VisibleChatItem[]): string {
  const activeTool = [...items]
    .reverse()
    .find((item) => item.kind === "tool" && item.result === undefined);
  if (activeTool?.kind === "tool") {
    return toolActivityLabel(activeTool);
  }

  const lastItem = items.at(-1);
  if (lastItem?.kind === "text" && lastItem.role === "assistant") {
    return "Анализирует найденные данные";
  }
  return "Аналитик работает";
}

function activityStepLabel(
  item: Extract<VisibleChatItem, { kind: "tool" }>,
): string {
  switch (toolActivityLabel(item)) {
    case "Ищет источники":
      return "Поиск источников";
    case "Проверяет источник":
      return "Проверка источников";
    case "Сохраняет отчёт":
      return "Сохранение отчёта";
    default:
      return "Выполнение инструментов";
  }
}

/** Project a transcript into the compact activity menu shown above every chat. */
export function activitySnapshotFor(
  items: readonly VisibleChatItem[],
  busy: boolean,
  stopped?: string,
  run?: AgentRunState,
): ActivitySnapshot {
  const lastUserIndex = items.findLastIndex(
    (item) => item.kind === "text" && item.role === "user",
  );
  const turnItems = lastUserIndex < 0 ? items : items.slice(lastUserIndex);
  const tools = turnItems.filter(
    (item): item is Extract<VisibleChatItem, { kind: "tool" }> =>
      item.kind === "tool",
  );
  const activeTool = [...tools]
    .reverse()
    .find((item) => item.result === undefined);
  const hasReasoning = turnItems.some((item) => item.kind === "reasoning");
  const assistantTexts = turnItems
    .filter(
      (item): item is Extract<VisibleChatItem, { kind: "text" }> =>
        item.kind === "text" && item.role === "assistant",
    )
    .map((item) => item.text);
  const hasAnswer = assistantTexts.some((text) => !isProgressNote(text));
  const hasOutput = assistantTexts.length > 0 || tools.length > 0;
  const hasIncompleteResult = hasOutput && !hasAnswer;
  const label = busy
    ? activeTool
      ? activityLabelFor([activeTool])
      : items.length === 0
        ? "Принимает задачу"
        : activityLabelFor(turnItems)
    : stopped
      ? "Остановлено"
      : hasAnswer
        ? "Последний запрос завершён"
        : hasIncompleteResult
          ? "Результат не подтверждён"
          : "Готов к работе";

  const steps: ActivityStep[] = [];
  if (turnItems.length > 0) {
    steps.push({ id: "request", label: "Запрос принят", state: "done" });
  }
  if (hasReasoning) {
    steps.push({
      id: "plan",
      label: busy && tools.length === 0 ? "Планирование" : "План составлен",
      state: busy && tools.length === 0 ? "active" : "done",
    });
  }

  const seenTools = new Set<string>();
  for (const tool of tools) {
    const toolLabel = activityStepLabel(tool);
    if (seenTools.has(toolLabel)) continue;
    seenTools.add(toolLabel);
    steps.push({
      id: toolLabel,
      label: toolLabel,
      state: tool.result === undefined ? "active" : "done",
    });
  }

  if (hasAnswer) {
    steps.push({
      id: "answer",
      label: busy ? "Ответ формируется" : "Ответ готов",
      state: busy ? "active" : "done",
    });
  }
  if (!busy && hasIncompleteResult) {
    steps.push({
      id: "incomplete-result",
      label: "Результат не подтверждён",
      state: "warning",
    });
  }
  if (busy && steps.every((step) => step.state !== "active")) {
    steps.push({ id: "current", label, state: "active" });
  }

  const base: ActivitySnapshot = {
    label,
    status: stopped
      ? "stopped"
      : busy
        ? "working"
        : hasAnswer
          ? "done"
          : hasIncompleteResult
            ? "incomplete"
            : "idle",
    statusLabel: stopped
      ? "Остановлено"
      : busy
        ? "В работе"
        : hasAnswer
          ? "Готово"
          : hasIncompleteResult
            ? "Нет результата"
            : "Ожидает",
    steps: steps.slice(-5),
    toolCount: tools.length,
    elapsedMs: run?.elapsedMs ?? 0,
  };

  // The transcript is still the source of truth for the answer, while the explicit run state is
  // the source of truth for what is happening between messages. This prevents a long tool call or a
  // reconnect gap from looking idle just because no new message has arrived yet.
  if (!run || (run.status === "completed" && run.startedAt === null))
    return base;

  const active = busy || isAgentRunActive(run.status);
  const explicitLabel = agentRunStatusLabel(run.status);
  // `busy` is the logical turn and can briefly outlive (or precede) a protocol run. A terminal
  // protocol snapshot must not leak its "Ответ готов" label into that gap while the turn is still
  // doing work, especially around a browser-tool handoff.
  const activeLabel = isAgentRunActive(run.status) ? explicitLabel : base.label;
  const explicitStatus = active
    ? "working"
    : run.status === "failed" || run.status === "cancelled"
      ? "stopped"
      : hasAnswer
        ? "done"
        : "incomplete";
  const explicitStatusLabel = active
    ? "В работе"
    : run.status === "failed"
      ? "Ошибка"
      : run.status === "cancelled"
        ? "Остановлено"
        : hasAnswer
          ? "Готово"
          : "Нет результата";
  const explicitSteps = active
    ? [
        ...base.steps.filter((step) => step.state !== "active"),
        { id: "run-phase", label: activeLabel, state: "active" as const },
      ]
    : base.steps;

  return {
    ...base,
    label: active ? activeLabel : base.label,
    status: explicitStatus,
    statusLabel: explicitStatusLabel,
    steps: explicitSteps.slice(-5),
    runStatus: run.status,
  };
}

/**
 * Keep the live edge cheap without throwing conversation history away.
 *
 * The complete message list still belongs to the agent and is sent back on the next turn. This only
 * limits how many expensive markdown/tool rows mount in the browser at once; a person can reveal
 * the older rows from the transcript when they need them.
 */
export function newestVisibleChatItems(
  items: readonly VisibleChatItem[],
  limit: number,
): VisibleChatWindow {
  const safeLimit = Math.max(1, Math.floor(limit));
  const hidden = Math.max(0, items.length - safeLimit);
  return {
    items: hidden === 0 ? items : items.slice(hidden),
    hidden,
  };
}

/**
 * Project a bounded transcript window from the newest message backwards.
 *
 * The agent keeps the complete `messages` array. This reader never slices or rewrites it; it walks
 * from the durable tail so a tool result is observed before the assistant tool call it completes.
 * Reasoning stays available to lifecycle/activity projections through `toVisibleChatItems`, but it
 * does not consume a transcript row and is never returned here.
 *
 * A non-null `startId` pins an older window to a real row. New messages can then arrive at the tail
 * without moving what the reader is looking at. Only the nearest `size - 1` newer rows are retained,
 * so both the returned window and the scan's working set stay bounded.
 */
export function projectTranscriptWindow(
  messages: ReadonlyArray<Readonly<Message>>,
  { size, startId = null, olderStep = 60 }: TranscriptWindowOptions,
): TranscriptWindow {
  type TranscriptItem = Exclude<VisibleChatItem, { kind: "reasoning" }>;

  const safeSize = Math.max(1, Math.floor(size));
  const safeOlderStep = Math.max(1, Math.floor(olderStep));
  const knownToolCallIds = toolCallIds(messages);
  const results = new Map<string, string | undefined>();
  const tailNewestFirst: TranscriptItem[] = [];
  const pinnedNewerNewestFirst: TranscriptItem[] = [];
  const pinnedNewestFirst: TranscriptItem[] = [];
  let foundPinnedStart = false;
  let total = 0;
  let newerThanPinned = 0;
  let tailOlderSeen = 0;
  let tailOlderStartId: string | null = null;
  let pinnedOlderSeen = 0;
  let pinnedOlderStartId: string | null = null;

  const visit = (item: TranscriptItem) => {
    total += 1;

    if (tailNewestFirst.length < safeSize) {
      tailNewestFirst.push(item);
    } else if (tailOlderSeen < safeOlderStep) {
      tailOlderSeen += 1;
      tailOlderStartId = item.id;
    }

    if (startId === null) return;
    if (!foundPinnedStart) {
      if (item.id === startId) {
        foundPinnedStart = true;
        newerThanPinned = total - 1;
        pinnedNewestFirst.push(...pinnedNewerNewestFirst, item);
        return;
      }
      if (safeSize > 1) {
        pinnedNewerNewestFirst.push(item);
        if (pinnedNewerNewestFirst.length > safeSize - 1) {
          pinnedNewerNewestFirst.shift();
        }
      }
      return;
    }
    if (pinnedOlderSeen < safeOlderStep) {
      pinnedOlderSeen += 1;
      pinnedOlderStartId = item.id;
    }
  };

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;

    if (isToolResult(message)) {
      // Scanning backwards sees the latest result first. Preserve it if malformed history contains
      // more than one result for the same call, matching the forward reader's last-result-wins rule.
      if (!results.has(message.toolCallId)) {
        results.set(message.toolCallId, message.content);
      }
      const recovered = recoveredArtifactToolCall(message, knownToolCallIds);
      if (recovered) {
        visit({
          kind: "tool",
          id: recovered.id,
          toolCall: recovered,
          result: message.content,
        });
      }
      continue;
    }

    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
        const toolCall = calls[callIndex];
        if (!toolCall) continue;
        visit({
          kind: "tool",
          id: toolCall.id,
          toolCall,
          ...(results.has(toolCall.id)
            ? { result: results.get(toolCall.id) }
            : {}),
        });
      }
      if (message.content) {
        visit({
          kind: "text",
          id: message.id,
          role: "assistant",
          text: message.content,
        });
      }
      continue;
    }

    if (message.role !== "user") continue;
    const text = userMessageText(message);
    const attachments = attachmentRefsFromContent(message.content);
    if (text || attachments.length > 0) {
      visit({
        kind: "text",
        id: message.id,
        role: "user",
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    }
  }

  if (startId !== null && foundPinnedStart) {
    const pinnedItems = [...pinnedNewestFirst].reverse();
    return {
      items: pinnedItems,
      hiddenBefore: Math.max(0, total - newerThanPinned - 1),
      hiddenAfter: Math.max(0, newerThanPinned - (pinnedItems.length - 1)),
      olderStartId: pinnedOlderStartId,
      resolvedStartId: startId,
    };
  }

  const items = tailNewestFirst.reverse();
  return {
    items,
    hiddenBefore: Math.max(0, total - items.length),
    hiddenAfter: 0,
    olderStartId: tailOlderStartId,
    resolvedStartId: null,
  };
}

/** A tool result, as it arrives, its own message, pointing back at the call it answers. */
type ToolResultMessage = { role: "tool"; toolCallId: string; content?: string };

function isToolResult(
  message: Readonly<Message>,
): message is Readonly<Message> & ToolResultMessage {
  return message.role === "tool" && "toolCallId" in message;
}

function toolCallIds(
  messages: ReadonlyArray<Readonly<Message>>,
): ReadonlySet<string> {
  return new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => call.id)
        : [],
    ),
  );
}

/**
 * Intelligence can retain a completed tool result while omitting its assistant call envelope.
 * Recover only a validated first-party artifact candidate; ArtifactCard still fetches authenticated
 * metadata and requires `source: agent_generated` before exposing a preview or download.
 */
function recoveredArtifactToolCall(
  message: Readonly<Message> & ToolResultMessage,
  knownToolCallIds: ReadonlySet<string>,
): ToolCall | null {
  if (
    knownToolCallIds.has(message.toolCallId) ||
    !parseArtifactToolResult(REMOTE_CREATE_ARTIFACT_TOOL_NAME, message.content)
  ) {
    return null;
  }
  return {
    id: message.toolCallId,
    type: "function",
    function: {
      name: REMOTE_CREATE_ARTIFACT_TOOL_NAME,
      arguments: "{}",
    },
  };
}

export function toVisibleChatItems(
  messages: ReadonlyArray<Readonly<Message>>,
): VisibleChatItem[] {
  const knownToolCallIds = toolCallIds(messages);
  // Gather results first so calls render with their current completion state in the same pass.
  const results = new Map<string, string | undefined>();
  for (const message of messages) {
    if (isToolResult(message)) results.set(message.toolCallId, message.content);
  }

  return messages.flatMap((message): VisibleChatItem[] => {
    if (isToolResult(message)) {
      const recovered = recoveredArtifactToolCall(message, knownToolCallIds);
      return recovered
        ? [
            {
              kind: "tool",
              id: recovered.id,
              toolCall: recovered,
              result: message.content,
            },
          ]
        : [];
    }
    if (message.role === "reasoning") {
      return message.content
        ? [{ kind: "reasoning", id: message.id, text: message.content }]
        : [];
    }
    if (message.role === "assistant") {
      const items: VisibleChatItem[] = [];
      if (message.content) {
        items.push({
          kind: "text",
          id: message.id,
          role: "assistant",
          text: message.content,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        items.push({
          kind: "tool",
          // One assistant message can carry multiple tool calls.
          id: toolCall.id,
          toolCall,
          ...(results.has(toolCall.id)
            ? { result: results.get(toolCall.id) }
            : {}),
        });
      }
      return items;
    }

    if (message.role !== "user") return [];

    const text = userMessageText(message);
    const attachments = attachmentRefsFromContent(message.content);

    return text || attachments.length > 0
      ? [
          {
            kind: "text",
            id: message.id,
            role: "user",
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
          },
        ]
      : [];
  });
}

function userMessageText(message: Readonly<Message>): string {
  if (message.role !== "user") return "";
  return textFromMessageContent(message.content);
}
