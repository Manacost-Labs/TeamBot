import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  activityLabelFor,
  activitySnapshotFor,
  newestVisibleChatItems,
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
