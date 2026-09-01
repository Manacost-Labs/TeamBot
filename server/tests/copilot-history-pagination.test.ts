import { describe, expect, test } from "bun:test";
import {
  InvalidHistoryCursor,
  paginateThreadMessages,
  validateHistoryCursor,
} from "../src/copilot-history-pagination";

function messages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    content: `message-${index + 1}`,
    id: `message-${index + 1}`,
    role: "assistant",
  }));
}

describe("paginateThreadMessages", () => {
  test("returns the latest bounded page and an opaque cursor", () => {
    const result = paginateThreadMessages(messages(125));

    expect(result.messages).toHaveLength(60);
    expect(result.messages[0]?.id).toBe("message-66");
    expect(result.messages.at(-1)?.id).toBe("message-125");
    expect(result.hasOlder).toBe(true);
    expect(result.olderCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.olderCursor).not.toContain("message-66");
  });

  test("walks older pages without overlap and stops at the beginning", () => {
    const all = messages(125);
    const latest = paginateThreadMessages(all);
    const middle = paginateThreadMessages(all, latest.olderCursor);
    const oldest = paginateThreadMessages(all, middle.olderCursor);

    expect(middle.messages[0]?.id).toBe("message-6");
    expect(middle.messages.at(-1)?.id).toBe("message-65");
    expect(oldest.messages.map((item) => item.id)).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
      "message-5",
    ]);
    expect(oldest.hasOlder).toBe(false);
    expect(oldest.olderCursor).toBeNull();
  });

  test("rejects a cursor from a changed history", () => {
    const cursor = paginateThreadMessages(messages(61)).olderCursor;

    expect(() =>
      paginateThreadMessages(
        [...messages(61), { content: "new", id: "new", role: "user" }],
        cursor,
      ),
    ).toThrow(InvalidHistoryCursor);
  });

  test("does not paginate histories whose rows have no stable ids", () => {
    const result = paginateThreadMessages(
      Array.from({ length: 61 }, (_, index) => ({ content: String(index) })),
    );

    expect(result.messages).toHaveLength(60);
    expect(result.hasOlder).toBe(false);
    expect(result.olderCursor).toBeNull();
  });

  test("rejects malformed and oversized cursors at the public boundary", () => {
    expect(() => validateHistoryCursor("not+a+base64url+cursor")).toThrow(
      InvalidHistoryCursor,
    );
    expect(() => validateHistoryCursor("a".repeat(2_049))).toThrow(
      InvalidHistoryCursor,
    );
  });
});
