import { describe, expect, test } from "bun:test";
import { createStallGuard } from "../src/channels/stall-guard";
import { mountCopilotRuntime } from "../src/copilot";

function threadMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    content: `message-${index + 1}`,
    id: `message-${index + 1}`,
    role: "assistant" as const,
  }));
}

describe("Copilot history endpoint", () => {
  test("returns bounded pages through the authenticated runtime handler", async () => {
    const realFetch = globalThis.fetch;
    const upstreamMessages = threadMessages(65);
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      requestedUrls.push(String(input));
      return Response.json({ messages: upstreamMessages });
    }) as typeof fetch;

    const stallGuard = createStallGuard({ stallMs: 0 });
    const mounted = mountCopilotRuntime(
      {
        accessibility: false,
        computer: undefined,
        runtime: {
          intelligence: {
            apiKey: "test-project-key",
            apiUrl: "http://intelligence.test",
            gatewayWsUrl: "ws://intelligence.test",
            licenseToken: "test-license",
          },
        },
      } as never,
      { provider: "openai", defaultModel: "test-model" },
      async () => [
        {
          id: "codex",
          name: "Codex",
          type: "built_in",
          systemPrompt: "Answer test requests.",
        },
      ],
      async () => "test-model-key",
      async () => ({ id: "user-1", name: "Test User" }),
      async () => ({ id: "user-1", email: "user@example.test", role: "user" }),
      stallGuard,
    );

    try {
      const firstResponse = await mounted.handler.request(
        "http://openbot.test/api/copilotkit/threads/thread-1/messages?agentId=codex",
      );
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      expect(first.messages).toHaveLength(60);
      expect(first.messages[0]?.id).toBe("message-6");
      expect(first.hasOlder).toBe(true);

      const secondResponse = await mounted.handler.request(
        `http://openbot.test/api/copilotkit/threads/thread-1/messages?agentId=codex&before=${encodeURIComponent(first.olderCursor)}`,
      );
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json();
      expect(
        second.messages.map((message: { id: string }) => message.id),
      ).toEqual([
        "message-1",
        "message-2",
        "message-3",
        "message-4",
        "message-5",
      ]);
      expect(second.hasOlder).toBe(false);
      const historyRequests = requestedUrls.filter((url) =>
        url.includes("thread-1"),
      );
      expect(historyRequests).toHaveLength(2);
      expect(
        historyRequests.every((url) => url.includes("userId=user-1")),
      ).toBe(true);

      const invalidResponse = await mounted.handler.request(
        `http://openbot.test/api/copilotkit/threads/thread-1/messages?agentId=codex&before=${"a".repeat(2_049)}`,
      );
      expect(invalidResponse.status).toBe(409);
      expect(
        requestedUrls.filter((url) => url.includes("thread-1")),
      ).toHaveLength(2);
    } finally {
      stallGuard.stop();
      globalThis.fetch = realFetch;
    }
  });
});
