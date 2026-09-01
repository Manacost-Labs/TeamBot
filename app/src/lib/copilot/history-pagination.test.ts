import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  createConversationStore,
  type HistoryPage,
} from "./conversation-store";
import {
  ConversationHistoryPaginator,
  type HistoryPageLoader,
} from "./history-pagination";

function message(id: string): Message {
  return { content: id, id, role: "assistant" } as Message;
}

function page(
  ids: readonly string[],
  olderCursor: string | null,
  hasOlder: boolean,
): HistoryPage {
  return {
    hasOlder,
    messages: ids.map(message),
    olderCursor,
    revision: "revision-1",
  };
}

describe("ConversationHistoryPaginator", () => {
  test("deduplicates concurrent loads and prepends an overlapping page", async () => {
    const store = createConversationStore();
    const calls: string[] = [];
    const loadPage: HistoryPageLoader = async ({ olderCursor }) => {
      calls.push(olderCursor);
      return page(["1", "2", "3"], null, false);
    };
    const paginator = new ConversationHistoryPaginator({
      initialPage: page(["3", "4"], "cursor-1", true),
      loadPage,
      store,
    });

    const first = paginator.loadOlder();
    const second = paginator.loadOlder();
    expect(first).toBe(second);
    await first;

    expect(calls).toEqual(["cursor-1"]);
    expect(store.getSnapshot().orderedMessageIds).toEqual(["1", "2", "3", "4"]);
    expect(paginator.getSnapshot()).toEqual({
      hasOlder: false,
      isLoading: false,
      olderCursor: null,
    });
  });

  test("does not request a page when there is no cursor", async () => {
    let calls = 0;
    const paginator = new ConversationHistoryPaginator({
      initialPage: page(["1"], null, false),
      loadPage: async () => {
        calls += 1;
        return page([], null, false);
      },
      store: createConversationStore(),
    });

    expect(await paginator.loadOlder()).toBeNull();
    expect(calls).toBe(0);
  });

  test("cancellation prevents a late page from changing the store", async () => {
    const store = createConversationStore();
    let resolvePage: ((value: HistoryPage) => void) | undefined;
    const paginator = new ConversationHistoryPaginator({
      initialPage: page(["2"], "cursor-1", true),
      loadPage: ({ signal }) =>
        new Promise<HistoryPage>((resolve) => {
          resolvePage = resolve;
          signal.addEventListener("abort", () => {}, { once: true });
        }),
      store,
    });

    const pending = paginator.loadOlder();
    paginator.cancel();
    resolvePage?.(page(["1"], null, false));

    expect(await pending).toBeNull();
    expect(store.getSnapshot().orderedMessageIds).toEqual(["2"]);
    expect(paginator.getSnapshot().isLoading).toBe(false);
  });

  test("keeps the cursor after a failed page so a later retry is possible", async () => {
    const store = createConversationStore();
    let calls = 0;
    const paginator = new ConversationHistoryPaginator({
      initialPage: page(["2"], "cursor-1", true),
      loadPage: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary history failure");
        return page(["1"], null, false);
      },
      store,
    });

    await expect(paginator.loadOlder()).rejects.toThrow(
      "temporary history failure",
    );
    expect(paginator.getSnapshot()).toEqual({
      hasOlder: true,
      isLoading: false,
      olderCursor: "cursor-1",
    });
    await paginator.loadOlder();
    expect(store.getSnapshot().orderedMessageIds).toEqual(["1", "2"]);
  });

  test("refreshes the latest cursor without dropping already loaded history", () => {
    const store = createConversationStore();
    const paginator = new ConversationHistoryPaginator({
      initialPage: page(["1", "2"], "cursor-2", true),
      loadPage: async () => page([], null, false),
      store,
    });

    paginator.observeLatestPage(page(["2", "3"], "cursor-3", true));

    expect(store.getSnapshot().orderedMessageIds).toEqual(["1", "2"]);
    expect(paginator.getSnapshot()).toEqual({
      hasOlder: true,
      isLoading: false,
      olderCursor: "cursor-3",
    });
  });
});
