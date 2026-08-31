import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { createAgentResponse } from "../src/agent-run";
import { runCodex } from "../src/codex-run";
import {
  createAgentExecutionTiming,
  type ExecutionTimingRecord,
} from "../src/execution-timing";

const input = {
  runId: "run-7",
  threadId: "thread-3",
  messages: [{ id: "user-1", role: "user", content: "SECRET PROMPT" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {
    openbotBotId: "codex",
    openbotRun: "SIGNED ASSERTION",
  },
} as unknown as RunAgentInput;

describe("agent-codex execution timing", () => {
  test("records first useful events once and preserves real SSE deltas", async () => {
    const records: ExecutionTimingRecord[] = [];
    let tick = 100;
    const timing = createAgentExecutionTiming(input, {
      requestId: "request-5",
      startedAt: tick,
      now: () => tick++,
      sink: (record) => records.push(record),
    });
    timing.recordAt("request_received", 100);
    timing.record("request_accepted");

    const response = createAgentResponse(input, {
      timing,
      run: async (_input, callbacks, runTiming) => {
        runTiming.record("child_process_spawned");
        runTiming.record("codex_initialized");
        runTiming.record("codex_thread_started");
        runTiming.record("codex_turn_started");
        callbacks.onReasoning("SAFE SUMMARY", "reasoning-1", 0);
        callbacks.onReasoning("SECOND SUMMARY", "reasoning-1", 0);
        callbacks.onToolStart("call-1", "private_tool", {
          credential: "CREDENTIAL",
        });
        callbacks.onToolStart("call-2", "other_tool", { prompt: "TOOL ARG" });
        callbacks.onText("Hel", "message-1");
        callbacks.onText("lo", "message-1");
      },
    });

    const events = await responseEvents(response);
    expect(
      events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta),
    ).toEqual(["Hel", "lo"]);
    expect(
      events.filter((event) => event.type === "RUN_FINISHED"),
    ).toHaveLength(1);

    expect(records.map((record) => record.phase)).toEqual([
      "request_received",
      "request_accepted",
      "run_started",
      "child_process_spawned",
      "codex_initialized",
      "codex_thread_started",
      "codex_turn_started",
      "first_reasoning",
      "first_tool",
      "first_text_delta",
      "run_completed",
    ]);
    for (const phase of ["first_reasoning", "first_tool", "first_text_delta"]) {
      expect(records.filter((record) => record.phase === phase)).toHaveLength(
        1,
      );
    }
    for (const record of records) {
      expect(record).toMatchObject({
        requestId: "request-5",
        runId: "run-7",
        threadId: "thread-3",
        agentId: "codex",
      });
    }

    const serialized = JSON.stringify(records);
    for (const forbidden of [
      "SECRET PROMPT",
      "SAFE SUMMARY",
      "SECOND SUMMARY",
      "private_tool",
      "other_tool",
      "CREDENTIAL",
      "TOOL ARG",
      "SIGNED ASSERTION",
      "Hel",
      "lo",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("records a content-free error terminal and emits one AG-UI error", async () => {
    const records: ExecutionTimingRecord[] = [];
    const timing = createAgentExecutionTiming(input, {
      requestId: "request-error",
      now: () => 50,
      sink: (record) => records.push(record),
    });

    const response = createAgentResponse(input, {
      timing,
      run: async () => {
        throw new TypeError("SECRET FAILURE BODY");
      },
    });
    const events = await responseEvents(response);

    expect(events.filter((event) => event.type === "RUN_ERROR")).toHaveLength(
      1,
    );
    expect(records.at(-1)).toMatchObject({
      phase: "run_error",
      errorType: "TypeError",
    });
    expect(JSON.stringify(records)).not.toContain("SECRET FAILURE BODY");
  });

  test("closes with one terminal when a protocol error precedes the pending RPC response", async () => {
    const records: ExecutionTimingRecord[] = [];
    const timing = createAgentExecutionTiming(input, {
      requestId: "request-protocol-error",
      now: () => records.length,
      sink: (record) => records.push(record),
    });
    const response = createAgentResponse(input, {
      timing,
      run: (runInput, callbacks, runTiming) =>
        runCodex(runInput, callbacks, {
          timing: runTiming,
          spawn: protocolErrorProcess,
        }),
    });

    const events = await responseEvents(response);
    expect(events.filter((event) => event.type === "RUN_ERROR")).toHaveLength(
      1,
    );
    expect(
      records.filter((record) => record.phase === "run_error"),
    ).toHaveLength(1);
    expect(records.map((record) => record.phase)).toContain(
      "child_process_spawned",
    );
    expect(JSON.stringify(records)).not.toContain("SECRET PROTOCOL DETAIL");
  });

  test("uses only the trusted forwarded bot id or explicit adapter fallback", () => {
    const records: ExecutionTimingRecord[] = [];
    const spoofed = {
      ...input,
      agentId: "body-spoof",
      forwardedProps: { openbotBotId: "managed-editor" },
    } as unknown as RunAgentInput;
    const managedTiming = createAgentExecutionTiming(spoofed, {
      agentId: "agent-codex",
      requestId: "managed-request",
      now: () => 0,
      sink: (record) => records.push(record),
    });
    managedTiming.record("request_received");

    const directTiming = createAgentExecutionTiming(
      {
        ...input,
        forwardedProps: {},
      } as unknown as RunAgentInput,
      {
        agentId: "agent-codex",
        requestId: "direct-request",
        now: () => 0,
        sink: (record) => records.push(record),
      },
    );
    directTiming.record("request_received");

    expect(records.map((record) => record.agentId)).toEqual([
      "managed-editor",
      "agent-codex",
    ]);
    expect(JSON.stringify(records)).not.toContain("body-spoof");
  });

  test("records a text-only run without inventing reasoning or tool phases", async () => {
    const records: ExecutionTimingRecord[] = [];
    const timing = createAgentExecutionTiming(input, {
      requestId: "request-text-only",
      now: () => records.length,
      sink: (record) => records.push(record),
    });
    const response = createAgentResponse(input, {
      timing,
      run: async (_input, callbacks) => {
        callbacks.onText("A", "message-text-only");
        callbacks.onText("B", "message-text-only");
      },
    });

    const events = await responseEvents(response);
    expect(records.map((record) => record.phase)).toEqual([
      "run_started",
      "first_text_delta",
      "run_completed",
    ]);
    expect(
      events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta),
    ).toEqual(["A", "B"]);
  });

  test("keeps a tool-first run ordered and records each first milestone once", async () => {
    const records: ExecutionTimingRecord[] = [];
    const timing = createAgentExecutionTiming(input, {
      requestId: "request-tool-first",
      now: () => records.length,
      sink: (record) => records.push(record),
    });
    const response = createAgentResponse(input, {
      timing,
      run: async (_input, callbacks) => {
        callbacks.onToolStart("call-1", "safe_tool", {});
        callbacks.onToolResult("call-1", "ok");
        callbacks.onToolStart("call-2", "second_tool", {});
        callbacks.onText("done", "message-tool-first");
      },
    });

    const events = await responseEvents(response);
    expect(records.map((record) => record.phase)).toEqual([
      "run_started",
      "first_tool",
      "first_text_delta",
      "run_completed",
    ]);
    expect(events.map((event) => event.type)).toContain("TOOL_CALL_RESULT");
    expect(events.map((event) => event.type)).toContain("RUN_FINISHED");
  });

  test("records delivery cancellation once while allowing maintenance to finish", async () => {
    const records: ExecutionTimingRecord[] = [];
    const timing = createAgentExecutionTiming(input, {
      requestId: "request-cancel",
      now: () => records.length,
      sink: (record) => records.push(record),
    });
    let releaseRun = () => {};
    let settled = 0;
    let markStarted = () => {};
    let markFinished = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });

    const response = createAgentResponse(input, {
      timing,
      onSettled: () => {
        settled += 1;
      },
      run: async () => {
        markStarted();
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        markFinished();
      },
    });
    await started;
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();
    expect(settled).toBe(0);
    releaseRun();
    await finished;
    await Promise.resolve();

    expect(
      records.filter((record) => record.phase === "stream_cancelled"),
    ).toHaveLength(1);
    expect(records.map((record) => record.phase)).toContain("run_completed");
    expect(settled).toBe(1);
  });
});

async function responseEvents(response: Response): Promise<BaseEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent);
}

function protocolErrorProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill(): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  queueMicrotask(() => child.emit("spawn"));
  child.stdin.once("data", () => {
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          method: "error",
          params: { message: "SECRET PROTOCOL DETAIL", willRetry: false },
        })}\n`,
      );
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}
