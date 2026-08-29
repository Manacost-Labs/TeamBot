import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  newestVisibleChatItems,
  toVisibleChatItems,
  type VisibleChatItem,
} from "./chat-messages";

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
