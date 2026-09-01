import { afterEach, describe, expect, test } from "bun:test";
import {
  cachedThreadMessages,
  clearThreadMessagesCache,
  createThreadHistoryCache,
  mergeAuthoritativeThreadMessages,
  mergeThreadMessagesById,
  readableHistoryPage,
  readableTurns,
  refreshThreadHistoryPage,
  refreshThreadMessages,
} from "../src/lib/copilot/thread-messages";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearThreadMessagesCache("user-a");
});

/**
 * Reading back a conversation that used a tool.
 *
 * The shapes below are copied from a live thread rather than invented. The store writes a tool call
 * as `{id, name, args}`; AG-UI describes `{id, type: "function", function: {name, arguments}}`. A
 * reader that insists on the second and refuses the first throws away every turn in which a Bot did
 * anything, which is the half of the conversation worth keeping.
 */
const userTurn = {
  id: "6953d56c",
  role: "user",
  content: "open hackernews.com and tell me the top 3 stories",
};

/** As the history store writes it. */
const storedToolCall = {
  id: "0fe7b049",
  role: "assistant",
  toolCalls: [
    {
      id: "call_maB4q3",
      name: "computer_navigate",
      args: '{"url":"https://news.ycombinator.com"}',
    },
  ],
};

const toolResult = {
  id: "aa5e9452",
  role: "tool",
  toolCallId: "call_maB4q3",
  content: '{"ok":true,"title":"Hacker News"}',
};

const answer = { id: "5c1f", role: "assistant", content: "Top 3 stories…" };

describe("restoring a conversation that used a tool", () => {
  test("a browsing turn survives the read", () => {
    const { messages, unreadable } = readableTurns([
      userTurn,
      storedToolCall,
      toolResult,
      answer,
    ]);

    // Every one of them, and the tool call above all: without it the transcript keeps the sentence
    // the Bot wrote and loses the browsing that produced it.
    expect(messages).toHaveLength(4);
    expect(unreadable).toBe(0);
  });

  test("the tool call comes back in the shape every renderer reads", () => {
    const { messages } = readableTurns([storedToolCall]);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_maB4q3",
          type: "function",
          function: {
            name: "computer_navigate",
            arguments: '{"url":"https://news.ycombinator.com"}',
          },
        },
      ],
    });
  });

  test("a call already in AG-UI's shape is left alone", () => {
    const already = {
      id: "x",
      role: "assistant",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "computer_click", arguments: "{}" },
        },
      ],
    };
    const { messages, unreadable } = readableTurns([already]);
    expect(unreadable).toBe(0);
    expect(messages[0]).toEqual(already as never);
  });

  test("a turn that is genuinely malformed is still refused", () => {
    /*
     * The guard is not being removed, only taught a second spelling. A tool call with neither shape
     * is something no renderer can draw, and letting it through is how one bad turn used to take a
     * whole conversation down.
     */
    const nonsense = { id: "y", role: "assistant", toolCalls: [{ id: "c2" }] };
    const { messages, unreadable } = readableTurns([nonsense]);
    expect(messages).toHaveLength(0);
    expect(unreadable).toBe(1);
  });

  test("a mixed array is refused rather than half-translated", () => {
    // Guessing at half of it would be this file inventing history rather than reading it.
    const mixed = {
      id: "z",
      role: "assistant",
      toolCalls: [
        { id: "a", name: "one", args: "{}" },
        {
          id: "b",
          type: "function",
          function: { name: "two", arguments: "{}" },
        },
      ],
    };
    expect(readableTurns([mixed]).unreadable).toBe(1);
  });

  test("everything else passes through untouched", () => {
    const { messages, unreadable } = readableTurns([userTurn, answer]);
    expect(unreadable).toBe(0);
    expect(messages[0]).toEqual(userTurn as never);
  });
});

/**
 * The cases the rewrite dropped, plus the one it never had.
 *
 * A reader that translates between two dialects is exactly where a quiet data-loss bug lives, and
 * these are the shapes a real thread contains: arguments the store kept as an object, content that
 * is a list of parts rather than a string, a turn with no content at all, and an order that has to
 * survive the trip because a conversation read out of sequence is not the conversation.
 */
describe("shapes a real thread contains", () => {
  test("arguments the store kept as an object become a string", () => {
    const [turn] = readableTurns([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [
          { id: "c1", name: "computer_navigate", args: { url: "https://x" } },
        ],
      },
    ]).messages as Array<Record<string, unknown>>;

    const call = (turn.toolCalls as Array<Record<string, unknown>>)[0];
    const fn = call.function as Record<string, unknown>;
    /*
     * AG-UI types this as a string. Passing the object through produced a call that looked
     * translated and still failed validation, so the turn was dropped anyway: this function's own
     * bug, one layer down.
     */
    expect(typeof fn.arguments).toBe("string");
    expect(JSON.parse(fn.arguments as string)).toEqual({ url: "https://x" });
  });

  test("a string of arguments is passed through exactly", () => {
    const [turn] = readableTurns([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [{ id: "c1", name: "t", args: '{"url": "https://x"}' }],
      },
    ]).messages as Array<Record<string, unknown>>;

    const call = (turn.toolCalls as Array<Record<string, unknown>>)[0];
    // Down to the whitespace: it may be a fragment of a stream that was never valid JSON, and
    // re-encoding it would change what the model actually said.
    expect((call.function as Record<string, unknown>).arguments).toBe(
      '{"url": "https://x"}',
    );
  });

  /*
   * A call with no arguments at all. Not `args` missing entirely, which the dialect check refuses on
   * purpose so that it never rewrites something that was not a stored call in the first place.
   */
  test("a call with empty arguments becomes something a reader can parse", () => {
    const [turn] = readableTurns([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [{ id: "c1", name: "t", args: null }],
      },
    ]).messages as Array<Record<string, unknown>>;

    const call = (turn.toolCalls as Array<Record<string, unknown>>)[0];
    expect((call.function as Record<string, unknown>).arguments).toBe("{}");
  });

  /*
   * A turn that called a tool and said nothing alongside it is written exactly this way, and it was
   * being dropped: the same loss the tool-call dialect caused, arriving by a different route. The
   * schema makes an assistant's content optional and does not allow null, so the two say the same
   * thing and only one parsed.
   */
  test("an assistant turn that said nothing while it worked survives", () => {
    const { messages, unreadable } = readableTurns([
      {
        id: "m1",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "computer_navigate", args: "{}" }],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(unreadable).toBe(0);
  });

  /*
   * And a person's turn is not the same case. Content is required there, so `null` is not a message
   * somebody sent: it used to reach a projection and draw as a blank line. Refused and counted, so
   * the surface can say so, which is the decision #207 made and this does not disturb.
   */
  test("a person's turn with no content is still refused and counted", () => {
    const { messages, unreadable } = readableTurns([
      { id: "m1", role: "user", content: null },
    ]);

    expect(messages).toEqual([]);
    expect(unreadable).toBe(1);
  });

  test("content that is a list of parts survives", () => {
    const content = [{ type: "text", text: "What is in this?" }];

    const { messages, unreadable } = readableTurns([
      { id: "m1", role: "user", content },
    ]);

    expect(messages).toHaveLength(1);
    expect(unreadable).toBe(0);
  });

  test("the order of the conversation is the order it came in", () => {
    const read = readableTurns([
      { id: "m1", role: "user", content: "one" },
      {
        id: "m2",
        role: "assistant",
        toolCalls: [
          { id: "c1", name: "computer_navigate", args: { url: "u" } },
        ],
      },
      { id: "m3", role: "assistant", content: "three" },
    ]).messages as Array<Record<string, unknown>>;

    expect(read.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(read[0]?.content).toBe("one");
    expect(read[2]?.content).toBe("three");
  });
});

describe("bounded stale-while-revalidate history", () => {
  test("reads a cursor page without exposing the cursor as a message field", () => {
    const page = readableHistoryPage({
      messages: [{ id: "one", role: "assistant", content: "One" }],
      olderCursor: "opaque-before-one",
      hasOlder: true,
      revision: "rev-7",
    });

    expect(page.messages).toHaveLength(1);
    expect(page.olderCursor).toBe("opaque-before-one");
    expect(page.hasOlder).toBe(true);
    expect(page.revision).toBe("rev-7");
    expect(page.unreadable).toBe(0);
  });

  test("requests an older page through the opaque before cursor", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          messages: [{ id: "older", role: "assistant", content: "Older" }],
          olderCursor: null,
          hasOlder: false,
          revision: "rev-7",
        }),
      } as Response;
    }) as typeof fetch;

    const result = await refreshThreadHistoryPage(
      "user-a",
      "thread with spaces",
      "agent/a",
      { olderCursor: "cursor/opaque" },
    );

    expect(requestedUrl).toContain("agentId=agent%2Fa");
    expect(requestedUrl).toContain("before=cursor%2Fopaque");
    expect(result.messages[0]?.id).toBe("older");
    expect(result.hasOlder).toBe(false);
  });

  test("returns a cached 500-message tail immediately and marks it stale", () => {
    const cache = createThreadHistoryCache({
      maxEntries: 2,
      maxMessagesPerEntry: 500,
      now: () => 100,
    });
    cache.set("user-a", "thread-a", "agent", {
      messages: Array.from({ length: 600 }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant" as const,
        content: `Answer ${index}`,
      })),
      unreadable: 0,
    });

    const cached = cache.peek("user-a", "thread-a", "agent");
    expect(cached?.stale).toBe(true);
    expect(cached?.complete).toBe(false);
    expect(cached?.messages).toHaveLength(500);
    expect(cached?.messages[0]?.id).toBe("message-100");
  });

  test("marks a cached snapshot complete when no authoritative messages were trimmed", () => {
    const cache = createThreadHistoryCache({ maxMessagesPerEntry: 500 });
    cache.set("user-a", "thread-a", "agent", {
      messages: [
        { id: "message-1", role: "user", content: "Question" },
        { id: "message-2", role: "assistant", content: "Answer" },
      ],
      unreadable: 0,
    });

    expect(cache.peek("user-a", "thread-a", "agent")?.complete).toBe(true);
  });

  test("keeps a bounded server page marked incomplete while older history exists", () => {
    const cache = createThreadHistoryCache({ maxMessagesPerEntry: 500 });
    cache.set("user-a", "thread-a", "agent", {
      messages: Array.from({ length: 60 }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant" as const,
        content: `Answer ${index}`,
      })),
      unreadable: 0,
      olderCursor: "opaque-cursor",
      hasOlder: true,
      revision: "revision-1",
    });

    expect(cache.peek("user-a", "thread-a", "agent")?.complete).toBe(false);
  });

  test("keeps cache content isolated by authenticated user scope", () => {
    const cache = createThreadHistoryCache();
    cache.set("user-a", "thread", "agent", {
      messages: [{ id: "private-a", role: "assistant", content: "A" }],
      unreadable: 0,
    });

    expect(cache.peek("user-b", "thread", "agent")).toBeNull();
    cache.clearScope("user-a");
    expect(cache.peek("user-a", "thread", "agent")).toBeNull();
  });

  test("does not recreate a cleared session cache from an aborted late response", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return {
        ok: true,
        json: async () => {
          controller.abort(new Error("signed out"));
          return {
            messages: [
              { id: "private-a", role: "assistant", content: "Secret A" },
            ],
          };
        },
      } as Response;
    }) as typeof fetch;

    await expect(
      refreshThreadMessages("user-a", "thread", "agent", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("signed out");

    expect(cachedThreadMessages("user-a", "thread", "agent")).toBeNull();
  });

  test("does not recreate a cleared session cache from a late refresh without an abort signal", async () => {
    let markJsonStarted = () => {};
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve;
    });
    let releaseJson = () => {};
    const jsonReleased = new Promise<void>((resolve) => {
      releaseJson = resolve;
    });
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => {
          markJsonStarted();
          await jsonReleased;
          return {
            messages: [
              { id: "private-a", role: "assistant", content: "Secret A" },
            ],
          };
        },
      }) as Response) as typeof fetch;

    const refreshing = refreshThreadMessages("user-a", "late", "agent");
    await jsonStarted;
    clearThreadMessagesCache("user-a");
    releaseJson();
    await refreshing;

    expect(cachedThreadMessages("user-a", "late", "agent")).toBeNull();
  });

  test("merges refreshed history in server order while retaining equal row identity", () => {
    const first = { id: "one", role: "user" as const, content: "One" };
    const second = { id: "two", role: "assistant" as const, content: "Two" };
    const merged = mergeThreadMessagesById(
      [first, second],
      [
        { id: "one", role: "user", content: "One" },
        { id: "two", role: "assistant", content: "Two updated" },
        { id: "three", role: "assistant", content: "Three" },
      ],
    );

    expect(merged.map((message) => message.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(merged[0]).toBe(first);
    expect(merged[1]).not.toBe(second);
    expect(merged[1]?.content).toBe("Two updated");

    const authoritative = mergeThreadMessagesById(
      [first, second],
      [{ id: "one", role: "user", content: "One" }],
      { retainMissing: false },
    );
    expect(authoritative.map((message) => message.id)).toEqual(["one"]);
  });

  test("an authoritative empty revision clears a stale cached tail", () => {
    const stale = {
      id: "stale",
      role: "assistant" as const,
      content: "No longer on the server",
    };

    expect(mergeAuthoritativeThreadMessages([stale], [], false)).toEqual([]);
  });

  test("a shorter authoritative revision drops stale rows before the first local write", () => {
    const retained = {
      id: "one",
      role: "user" as const,
      content: "One",
    };
    const stale = {
      id: "stale",
      role: "assistant" as const,
      content: "Stale",
    };
    const merged = mergeAuthoritativeThreadMessages(
      [retained, stale],
      [{ ...retained, content: "One updated" }],
      false,
    );

    expect(merged.map((message) => message.id)).toEqual(["one"]);
    expect(merged[0]?.content).toBe("One updated");
  });

  test("an authoritative revision does not remove rows created after the first local write", () => {
    const persisted = {
      id: "one",
      role: "user" as const,
      content: "One",
    };
    const local = {
      id: "local",
      role: "assistant" as const,
      content: "A streamed row that is not persisted yet",
    };

    const merged = mergeAuthoritativeThreadMessages(
      [persisted, local],
      [persisted],
      true,
    );

    expect(merged).toEqual([persisted, local]);
  });
});
