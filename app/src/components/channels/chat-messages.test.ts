import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  activityLabelFor,
  activitySnapshotFor,
  newestVisibleChatItems,
  projectTranscriptWindow,
  toVisibleChatItems,
  type VisibleChatItem,
} from "./chat-messages";

describe("activityLabelFor", () => {
  test("describes source search while a source command is in flight", () => {
    expect(
      activityLabelFor([
        {
          kind: "tool",
          id: "tool-1",
          toolCall: {
            id: "tool-1",
            type: "function",
            function: {
              name: "shell",
              arguments: "research-source tinyfish-search --query Hearthstone",
            },
          },
        },
      ]),
    ).toBe("Ищет источники");
  });

  test("keeps the activity visible after an assistant plan starts streaming", () => {
    expect(
      activityLabelFor([
        {
          kind: "text",
          id: "assistant-1",
          role: "assistant",
          text: "План зафиксирован.",
        },
      ]),
    ).toBe("Анализирует найденные данные");
  });

  test("describes source verification for a fetch command", () => {
    expect(
      activityLabelFor([
        {
          kind: "tool",
          id: "tool-2",
          toolCall: {
            id: "tool-2",
            type: "function",
            function: {
              name: "shell",
              arguments:
                "research-source tinyfish-fetch --url https://example.com",
            },
          },
        },
      ]),
    ).toBe("Проверяет источник");
  });
});

describe("activitySnapshotFor", () => {
  test("keeps a completed activity menu after the answer arrives", () => {
    const snapshot = activitySnapshotFor(
      [
        { kind: "text", id: "user", role: "user", text: "Собери отчёт" },
        {
          kind: "tool",
          id: "tool-1",
          toolCall: {
            id: "tool-1",
            type: "function",
            function: {
              name: "shell",
              arguments: "research-source stats-api --operation datasets",
            },
          },
          result: "готово",
        },
        { kind: "text", id: "answer", role: "assistant", text: "Готово" },
      ],
      false,
    );

    expect(snapshot.status).toBe("done");
    expect(snapshot.statusLabel).toBe("Готово");
    expect(snapshot.steps.at(-1)).toEqual({
      id: "answer",
      label: "Ответ готов",
      state: "done",
    });
  });

  test("marks the current source phase while a tool is running", () => {
    const snapshot = activitySnapshotFor(
      [
        { kind: "text", id: "user", role: "user", text: "Проверь источники" },
        {
          kind: "tool",
          id: "tool-1",
          toolCall: {
            id: "tool-1",
            type: "function",
            function: {
              name: "shell",
              arguments:
                "research-source tinyfish-fetch --url https://example.com",
            },
          },
        },
      ],
      true,
    );

    expect(snapshot.status).toBe("working");
    expect(snapshot.label).toBe("Проверяет источник");
    expect(snapshot.steps.at(-1)).toEqual({
      id: "Проверка источников",
      label: "Проверка источников",
      state: "active",
    });
  });

  test("uses the explicit run phase during a quiet transport interval", () => {
    const snapshot = activitySnapshotFor(
      [{ kind: "text", id: "user", role: "user", text: "Собери отчёт" }],
      true,
      undefined,
      {
        status: "reconnecting",
        runId: "run-1",
        startedAt: 100,
        updatedAt: 900,
        finishedAt: null,
        elapsedMs: 800,
        reconnectCount: 1,
        toolName: null,
        hasAssistantOutput: false,
        error: null,
      },
    );

    expect(snapshot.status).toBe("working");
    expect(snapshot.runStatus).toBe("reconnecting");
    expect(snapshot.label).toBe("Восстанавливает соединение");
    expect(snapshot.elapsedMs).toBe(800);
  });

  test("does not call a progress-only research transcript a completed result", () => {
    const snapshot = activitySnapshotFor(
      [
        { kind: "text", id: "user", role: "user", text: "Собери исследование" },
        {
          kind: "text",
          id: "progress-1",
          role: "assistant",
          text: "Начинаю исследование и фиксирую план.",
        },
        {
          kind: "text",
          id: "progress-2",
          role: "assistant",
          text: "Первый проход завершён, но источники ещё проверяются.",
        },
      ],
      false,
    );

    expect(snapshot.status).toBe("incomplete");
    expect(snapshot.statusLabel).toBe("Нет результата");
    expect(snapshot.label).toBe("Результат не подтверждён");
    expect(snapshot.steps.at(-1)).toEqual({
      id: "incomplete-result",
      label: "Результат не подтверждён",
      state: "warning",
    });
  });
});

describe("toVisibleChatItems", () => {
  test("keeps attachment-only user messages and exposes only opaque binary references", () => {
    const messages = [
      {
        id: "with-file",
        role: "user" as const,
        content: [
          {
            type: "binary" as const,
            id: "attachment-1",
            mimeType: "application/pdf",
            filename: "report.pdf",
          },
        ],
      },
    ];

    expect(toVisibleChatItems(messages)).toEqual([
      {
        kind: "text",
        id: "with-file",
        role: "user",
        text: "",
        attachments: [
          {
            type: "binary",
            id: "attachment-1",
            mimeType: "application/pdf",
            filename: "report.pdf",
          },
        ],
      },
    ]);
  });

  test("keeps official reasoning summaries as visible progress", () => {
    const messages = [
      { id: "user", role: "user", content: "Проверь источники" },
      {
        id: "reasoning:1",
        role: "reasoning",
        content: "Проверяю состояние всех источников.",
      },
    ] as Message[];

    expect(toVisibleChatItems(messages)).toEqual([
      {
        kind: "text",
        id: "user",
        role: "user",
        text: "Проверь источники",
      },
      {
        kind: "reasoning",
        id: "reasoning:1",
        text: "Проверяю состояние всех источников.",
      },
    ]);
  });
});

describe("newestVisibleChatItems", () => {
  const items: VisibleChatItem[] = Array.from({ length: 100 }, (_, index) => ({
    kind: "text",
    id: `message-${index}`,
    role: "assistant",
    text: `Answer ${index}`,
  }));

  test("mounts the newest rows and reports how many older rows are hidden", () => {
    const window = newestVisibleChatItems(items, 60);

    expect(window.hidden).toBe(40);
    expect(window.items).toHaveLength(60);
    expect(window.items[0]?.id).toBe("message-40");
    expect(window.items.at(-1)?.id).toBe("message-99");
  });

  test("keeps the original array when it already fits", () => {
    const window = newestVisibleChatItems(items, 100);

    expect(window.hidden).toBe(0);
    expect(window.items).toBe(items);
  });
});

describe("projectTranscriptWindow", () => {
  const longHistory = Array.from({ length: 500 }, (_, index) => ({
    id: `message-${index}`,
    role: "assistant" as const,
    content: `Answer ${index}`,
  }));

  test("projects the newest 60 rows without truncating the source history", () => {
    const window = projectTranscriptWindow(longHistory, { size: 60 });

    expect(longHistory).toHaveLength(500);
    expect(window.items).toHaveLength(60);
    expect(window.items[0]?.id).toBe("message-440");
    expect(window.items.at(-1)?.id).toBe("message-499");
    expect(window.hiddenBefore).toBe(440);
    expect(window.hiddenAfter).toBe(0);
    expect(window.olderStartId).toBe("message-380");
  });

  test("shifts a fixed-size window older and stays pinned when the live tail grows", () => {
    const tail = projectTranscriptWindow(longHistory, { size: 180 });
    const older = projectTranscriptWindow(longHistory, {
      size: 180,
      startId: tail.olderStartId,
    });
    const withNewTail = projectTranscriptWindow(
      [
        ...longHistory,
        { id: "message-500", role: "assistant", content: "Answer 500" },
      ],
      { size: 180, startId: tail.olderStartId },
    );

    expect(tail.items[0]?.id).toBe("message-320");
    expect(tail.olderStartId).toBe("message-260");
    expect(older.items).toHaveLength(180);
    expect(older.items[0]?.id).toBe("message-260");
    expect(older.items.at(-1)?.id).toBe("message-439");
    expect(older.hiddenBefore).toBe(260);
    expect(older.hiddenAfter).toBe(60);
    expect(withNewTail.items.map((item) => item.id)).toEqual(
      older.items.map((item) => item.id),
    );
    expect(withNewTail.hiddenAfter).toBe(61);
  });

  test("pairs a tool result from the tail and does not spend a row on reasoning", () => {
    const toolCall = {
      id: "tool-1",
      type: "function" as const,
      function: { name: "search", arguments: '{"query":"test"}' },
    };
    const window = projectTranscriptWindow(
      [
        {
          id: "assistant",
          role: "assistant",
          content: "Checking",
          toolCalls: [toolCall],
        },
        { id: "reasoning", role: "reasoning", content: "private trace" },
        {
          id: "tool-result",
          role: "tool",
          toolCallId: "tool-1",
          content: "Found",
        },
      ] as Message[],
      { size: 1 },
    );

    expect(window.items).toEqual([
      { kind: "tool", id: "tool-1", toolCall, result: "Found" },
    ]);
    expect(window.hiddenBefore).toBe(1);
  });

  test("recovers a persisted artifact result when its assistant tool call is missing", () => {
    const result = JSON.stringify({
      schema: "openbot.artifact.v1",
      artifact: {
        attachmentId: "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd",
        filename: "youtube-summary.md",
        mimeType: "text/markdown",
        size: 8782,
        title: "Конспект YouTube-видео",
      },
    });
    const window = projectTranscriptWindow(
      [
        {
          id: "artifact-result",
          role: "tool",
          toolCallId: "artifact-call",
          content: result,
        },
        {
          id: "answer",
          role: "assistant",
          content: "Успешных ссылок: 1. Недоступных: 0.",
        },
      ] as Message[],
      { size: 60 },
    );

    expect(window.items[0]).toMatchObject({
      kind: "tool",
      id: "artifact-call",
      result,
      toolCall: {
        function: { name: "openbot__artifacts__create_artifact" },
      },
    });
  });

  test("does not recover a malformed standalone tool result", () => {
    const window = projectTranscriptWindow(
      [
        {
          id: "tool-result",
          role: "tool",
          toolCallId: "unknown-call",
          content: '{"schema":"openbot.artifact.v1"}',
        },
      ] as Message[],
      { size: 60 },
    );

    expect(window.items).toEqual([]);
  });

  test("falls back to the live tail when a saved row no longer exists", () => {
    const window = projectTranscriptWindow(longHistory, {
      size: 60,
      startId: "deleted-message",
    });

    expect(window.resolvedStartId).toBeNull();
    expect(window.items[0]?.id).toBe("message-440");
    expect(window.items.at(-1)?.id).toBe("message-499");
  });
});
