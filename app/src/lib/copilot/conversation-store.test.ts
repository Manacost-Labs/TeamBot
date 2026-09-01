import { describe, expect, test } from "bun:test";
import { ConversationStore, type HistoryPage } from "./conversation-store";
import { initialAgentRunState } from "./run-state";

const page = (revision: string, messages: string[]): HistoryPage => ({
  messages: messages.map((id) => ({ id, role: "assistant", content: id })),
  olderCursor: messages[0] ?? null,
  hasOlder: messages.length > 0,
  revision,
});

describe("ConversationStore", () => {
  test("normalizes duplicate message ids and preserves the newest occurrence", () => {
    const store = new ConversationStore();
    const first = { id: "first", role: "user" as const, content: "old" };
    const replacement = {
      id: "first",
      role: "user" as const,
      content: "new",
    };
    store.replaceMessages([
      first,
      { id: "second", role: "assistant", content: "ok" },
      replacement,
    ]);

    expect(store.getSnapshot().orderedMessageIds).toEqual(["first", "second"]);
    expect(store.getSnapshot().messagesById.get("first")).toBe(replacement);
  });

  test("prepends a history page and deduplicates the cursor overlap", () => {
    const store = new ConversationStore();
    store.replaceMessages([
      { id: "b", role: "assistant", content: "b" },
      { id: "c", role: "assistant", content: "c" },
    ]);
    store.prependHistoryPage(page("r1", ["a", "b"]));

    expect(store.getSnapshot().orderedMessageIds).toEqual(["a", "b", "c"]);
    expect(store.getSnapshot().historyPages).toHaveLength(1);
  });

  test("replaces the latest history page without clearing live state", () => {
    const store = new ConversationStore();
    const nextPage = page("r2", ["fresh"]);
    store.setQueuedMessages([{ id: "queued", text: "Later", commandIds: [] }]);
    store.setActiveRun({ ...initialAgentRunState, status: "thinking" });

    store.replaceHistoryPage(nextPage);

    expect(store.getSnapshot().orderedMessageIds).toEqual(["fresh"]);
    expect(store.getSnapshot().historyPages).toEqual([nextPage]);
    expect(store.getSnapshot().queuedMessages).toEqual([
      { id: "queued", text: "Later", commandIds: [] },
    ]);
    expect(store.getSnapshot().activeRun?.status).toBe("thinking");
  });

  test("keeps the snapshot stable when replacing the same object list", () => {
    const store = new ConversationStore();
    const messages = [{ id: "a", role: "user" as const, content: "a" }];
    store.replaceMessages(messages, "r1");
    const snapshot = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.replaceMessages(messages, "r1");

    expect(store.getSnapshot()).toBe(snapshot);
    expect(notifications).toBe(0);
  });

  test("clears messages, pages and live state together", () => {
    const store = new ConversationStore();
    store.replaceMessages([{ id: "a", role: "user", content: "a" }], "r1");
    store.prependHistoryPage(page("r2", ["older"]));
    store.clear();

    expect(store.getSnapshot()).toEqual(new ConversationStore().getSnapshot());
  });
});
