import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import type {
  AgentExecutionTiming,
  ExecutionTimingRecord,
} from "../src/execution-timing";
import { createAgentRequestHandler } from "../src/request-handler";
import { RunAdmission } from "../src/run-admission";

const TOKEN = "managed-test-token";

function request(body: string) {
  return new Request("http://agent.test/ag-ui", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": TOKEN,
      "x-openbot-request-id": "request-7",
    },
    body,
  });
}

describe("agent-codex request boundary", () => {
  test("records authenticated malformed JSON without leaking its content", async () => {
    const records: ExecutionTimingRecord[] = [];
    const handle = createAgentRequestHandler({
      managedAgentToken: TOKEN,
      agentId: "agent-codex",
      now: () => records.length + 10,
      sink: (record) => records.push(record),
    });
    const response = await handle(request('{"secret":"DO NOT LOG"'));

    expect(response.status).toBe(400);
    expect(records.map((record) => record.phase)).toEqual([
      "request_received",
      "run_error",
    ]);
    expect(records.at(-1)?.errorType).toBe("InvalidJson");
    expect(JSON.stringify(records)).not.toContain("DO NOT LOG");
  });

  test("accepts only a schema-valid request and adds correlation after validation", async () => {
    const records: ExecutionTimingRecord[] = [];
    let accepted: RunAgentInput | undefined;
    const handle = createAgentRequestHandler({
      managedAgentToken: TOKEN,
      agentId: "agent-codex",
      now: () => records.length + 20,
      sink: (record) => records.push(record),
      respond: (input: RunAgentInput, _timing: AgentExecutionTiming) => {
        accepted = input;
        return new Response(null, { status: 202 });
      },
    });
    const response = await handle(
      request(
        JSON.stringify({
          threadId: "thread-3",
          runId: "run-7",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: { openbotBotId: "editor" },
        }),
      ),
    );

    expect(response.status).toBe(202);
    expect(accepted?.runId).toBe("run-7");
    expect(records.map((record) => record.phase)).toEqual([
      "request_received",
      "request_accepted",
    ]);
    expect(records[0]).not.toHaveProperty("runId");
    expect(records[1]).toMatchObject({
      requestId: "request-7",
      runId: "run-7",
      threadId: "thread-3",
      agentId: "editor",
    });
  });

  test("supplies safe defaults for an older authenticated editor request", async () => {
    let accepted: RunAgentInput | undefined;
    const handle = createAgentRequestHandler({
      managedAgentToken: TOKEN,
      agentId: "agent-codex",
      respond: (input: RunAgentInput) => {
        accepted = input;
        return new Response(null, { status: 202 });
      },
    });

    const response = await handle(
      request(
        JSON.stringify({
          threadId: "editor-thread-1",
          runId: "editor-run-1",
          messages: [
            { id: "editor-message-1", role: "system", content: "Правила" },
            { id: "editor-message-2", role: "user", content: "Текст" },
          ],
          tools: [],
          forwardedProps: { openbotAgentModel: "gpt-5.6-luna" },
        }),
      ),
    );

    expect(response.status).toBe(202);
    expect(accepted?.state).toEqual({});
    expect(accepted?.context).toEqual([]);
  });

  test("rejects valid JSON with an invalid AG-UI shape before the run", async () => {
    const records: ExecutionTimingRecord[] = [];
    const handle = createAgentRequestHandler({
      managedAgentToken: TOKEN,
      agentId: "agent-codex",
      now: () => records.length + 30,
      sink: (record) => records.push(record),
    });
    const response = await handle(request('{"messages":"PRIVATE"}'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request body.",
      invalidFields: ["threadId", "runId", "messages", "tools"],
    });
    expect(records.map((record) => record.phase)).toEqual([
      "request_received",
      "run_error",
    ]);
    expect(records.at(-1)?.errorType).toBe("InvalidRequest");
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });

  test("returns an explicit 429 without starting a run when admission is full", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 0,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    let settleFirst: (() => void) | undefined;
    let starts = 0;
    const handle = createAgentRequestHandler({
      managedAgentToken: TOKEN,
      agentId: "agent-codex",
      admission,
      respond: (_input, _timing, onSettled) => {
        starts += 1;
        settleFirst ??= onSettled;
        return new Response(null, { status: 202 });
      },
    });
    const body = JSON.stringify({
      threadId: "thread-admission",
      runId: "run-admission",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: { openbotBotId: "editor" },
    });

    expect((await handle(request(body))).status).toBe(202);
    const refused = await handle(request(body));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toEqual({
      error: "Managed run queue is full.",
    });
    expect(starts).toBe(1);

    settleFirst?.();
    expect((await handle(request(body))).status).toBe(202);
    expect(starts).toBe(2);
  });
});
