import { describe, expect, test } from "bun:test";
import { text } from "prompt-area/helpers";
import {
  anchoredScrollTop,
  createConversationStateCache,
} from "./conversation-state";

describe("bounded per-channel conversation state", () => {
  test("restores draft, scroll and transcript window across A to B to A", () => {
    const cache = createConversationStateCache({ maxEntries: 2 });
    cache.setDraft("channel-a", [text("unfinished A")]);
    cache.setScroll("channel-a", { distanceFromEnd: 40, scrollTop: 320 });
    cache.setHistoryLimit("channel-a", 180);

    cache.setDraft("channel-b", [text("unfinished B")]);
    expect(cache.get("channel-b").draft).toEqual([text("unfinished B")]);

    const restored = cache.get("channel-a");
    expect(restored.draft).toEqual([text("unfinished A")]);
    expect(restored.scrollTop).toBe(320);
    expect(restored.distanceFromEnd).toBe(40);
    expect(restored.historyLimit).toBe(180);
  });

  test("evicts the least recently used channel", () => {
    const cache = createConversationStateCache({ maxEntries: 2 });
    cache.setDraft("channel-a", [text("A")]);
    cache.setDraft("channel-b", [text("B")]);
    cache.get("channel-a");
    cache.setDraft("channel-c", [text("C")]);

    expect(cache.peek("channel-a")).not.toBeNull();
    expect(cache.peek("channel-b")).toBeNull();
    expect(cache.peek("channel-c")).not.toBeNull();
  });

  test("anchors the same visible row when older transcript rows are revealed", () => {
    expect(anchoredScrollTop(300, 1_000, 1_640)).toBe(940);
  });
});
