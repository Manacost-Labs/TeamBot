import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { serve } from "bun";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { runCodex } from "./codex-run";

const PORT = Number.parseInt(process.env.PORT ?? "4202", 10);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) throw new Error("MANAGED_AGENT_TOKEN is required.");

async function runAgent(input: RunAgentInput): Promise<Response> {
  const encoder = new EventEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
      // Bun cannot keep an HTTP request idle for more than 255 seconds. A validation or deployment
      // tool may legitimately run longer, so SSE comments keep the transport alive without adding
      // fake AG-UI events to the conversation.
      const keepAlive = setInterval(
        () => controller.enqueue(utf8.encode(": keep-alive\n\n")),
        30_000,
      );
      let openMessage: string | null = null;
      let openReasoning: string | null = null;
      const closeMessage = () => {
        if (!openMessage) return;
        send({ type: "TEXT_MESSAGE_END", messageId: openMessage } as BaseEvent);
        openMessage = null;
      };
      const closeReasoning = () => {
        if (!openReasoning) return;
        send({
          type: "REASONING_MESSAGE_END",
          messageId: openReasoning,
        } as BaseEvent);
        send({ type: "REASONING_END", messageId: openReasoning } as BaseEvent);
        openReasoning = null;
      };

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      try {
        await runCodex(input, {
          onText(delta, itemId) {
            closeReasoning();
            if (openMessage !== itemId) {
              closeMessage();
              openMessage = itemId;
              send({
                type: "TEXT_MESSAGE_START",
                messageId: itemId,
                role: "assistant",
              } as BaseEvent);
            }
            send({
              type: "TEXT_MESSAGE_CONTENT",
              messageId: itemId,
              delta,
            } as BaseEvent);
          },
          onReasoning(delta, itemId, summaryIndex) {
            closeMessage();
            const reasoningId = `reasoning:${itemId}:${summaryIndex}`;
            if (openReasoning !== reasoningId) {
              closeReasoning();
              openReasoning = reasoningId;
              send({
                type: "REASONING_START",
                messageId: reasoningId,
              } as BaseEvent);
              send({
                type: "REASONING_MESSAGE_START",
                messageId: reasoningId,
                role: "reasoning",
              } as BaseEvent);
            }
            send({
              type: "REASONING_MESSAGE_CONTENT",
              messageId: reasoningId,
              delta,
            } as BaseEvent);
          },
          onToolStart(callId, name, args) {
            closeMessage();
            closeReasoning();
            send({
              type: "TOOL_CALL_START",
              toolCallId: callId,
              toolCallName: name,
            } as BaseEvent);
            send({
              type: "TOOL_CALL_ARGS",
              toolCallId: callId,
              delta: JSON.stringify(args),
            } as BaseEvent);
            send({ type: "TOOL_CALL_END", toolCallId: callId } as BaseEvent);
          },
          onToolResult(callId, result) {
            send({
              type: "TOOL_CALL_RESULT",
              messageId: `${callId}-result`,
              toolCallId: callId,
              content: result,
              role: "tool",
            } as BaseEvent);
          },
        });
        closeMessage();
        closeReasoning();
        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
        closeMessage();
        closeReasoning();
        send({
          type: "RUN_ERROR",
          message:
            error instanceof Error ? error.message : "Codex could not answer.",
        } as BaseEvent);
      } finally {
        clearInterval(keepAlive);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

serve({
  port: PORT,
  // Bun caps this at 255 seconds; use the maximum for long validation tool calls.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        model: process.env.CODEX_MODEL?.trim() || "account-default",
        auth: "chatgpt",
      });
    }
    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
      return runAgent((await request.json()) as RunAgentInput);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-codex listening on http://localhost:${PORT}/ag-ui`);
