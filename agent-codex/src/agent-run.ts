import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { type CodexCallbacks, runCodex } from "./codex-run";
import type { AgentExecutionTiming } from "./execution-timing";
import type { PersonalProviderConnection } from "./provider-connection";
import { shouldExposeReasoning } from "./reasoning-visibility";
import { SafeStreamWriter } from "./safe-stream";

export type AgentRun = (
  input: RunAgentInput,
  callbacks: CodexCallbacks,
  timing: AgentExecutionTiming,
) => Promise<void>;

export type AgentResponseOptions = {
  timing: AgentExecutionTiming;
  run?: AgentRun;
  /** Kept inside the adapter and passed only to the isolated runtime-profile boundary. */
  providerConnection?: PersonalProviderConnection;
  /** Called only when the real run settles, not when an HTTP consumer disconnects. */
  onSettled?: () => void;
};

/** Translate a Codex app-server run into genuine AG-UI deltas without manufacturing progress events. */
export function createAgentResponse(
  input: RunAgentInput,
  options: AgentResponseOptions,
): Response {
  const encoder = new EventEncoder();
  const timing = options.timing;
  const execute: AgentRun =
    options.run ??
    ((runInput, callbacks, runTiming) =>
      runCodex(runInput, callbacks, {
        timing: runTiming,
        providerConnection: options.providerConnection,
      }));
  let writer: SafeStreamWriter | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const output = new SafeStreamWriter(controller);
      writer = output;
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        output.enqueue(utf8.encode(encoder.encodeSSE(event)));
      // Keep the HTTP transport alive during long real tools without adding synthetic AG-UI events.
      const keepAlive = setInterval(
        () => output.enqueue(utf8.encode(": keep-alive\n\n")),
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
      timing.record("run_started");
      try {
        await execute(
          input,
          {
            onText(delta, itemId) {
              closeReasoning();
              timing.record("first_text_delta");
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
              // Only the official concise summary on an allowed run is a safe reasoning milestone.
              if (!shouldExposeReasoning(input)) return;
              timing.record("first_reasoning");
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
              timing.record("first_tool");
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
          },
          timing,
        );
        closeMessage();
        closeReasoning();
        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        timing.record("run_completed");
      } catch (error) {
        closeMessage();
        closeReasoning();
        send({
          type: "RUN_ERROR",
          message:
            error instanceof Error ? error.message : "Codex could not answer.",
        } as BaseEvent);
        timing.record("run_error", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        clearInterval(keepAlive);
        try {
          output.close();
        } finally {
          options.onSettled?.();
        }
      }
    },
    cancel() {
      // Delivery ends, but maintenance work already running keeps its existing completion contract.
      timing.record("stream_cancelled");
      writer?.disconnect();
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
