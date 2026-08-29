import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { toVisibleChatItems } from "./chat-messages";

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
