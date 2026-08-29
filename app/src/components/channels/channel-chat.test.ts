import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { emotionForMessages } from "./channel-chat";

describe("emotionForMessages", () => {
  test("shows thought, search, work, and writing from actual stream events", () => {
    expect(
      emotionForMessages(
        [{ id: "r", role: "reasoning", content: "Планирую" }] as Message[],
        true,
      ),
    ).toBe("thinking");
    expect(
      emotionForMessages(
        [
          {
            id: "a",
            role: "assistant",
            toolCalls: [
              {
                id: "call",
                type: "function",
                function: { name: "audit_all_sources", arguments: "{}" },
              },
            ],
          },
        ] as Message[],
        true,
      ),
    ).toBe("searching");
    expect(
      emotionForMessages(
        [
          {
            id: "a",
            role: "assistant",
            toolCalls: [
              {
                id: "call",
                type: "function",
                function: { name: "publish_and_verify", arguments: "{}" },
              },
            ],
          },
        ] as Message[],
        true,
      ),
    ).toBe("working");
    expect(
      emotionForMessages(
        [{ id: "a", role: "assistant", content: "Готовлю ответ" }] as Message[],
        true,
      ),
    ).toBe("writing");
  });
});
