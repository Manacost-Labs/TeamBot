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

  test("returns an explicit retryable 503 while deployment drain is active", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 1,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    admission.startDraining();
    const handler = createAgentRequestHandler({
      managedAgentToken: TOKEN,
      agentId: "agent-codex",
      admission,
      respond: () => new Response("must not run"),
    });

    const response = await handler(
      request(
        JSON.stringify({
          threadId: "thread-draining",
          runId: "run-draining",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: { openbotBotId: "research-analyst" },
        }),
      ),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({
      error: "Managed runtime is draining for deployment.",
    });
  });

  test("redeems a personal provider once after admission and before the run starts", async () => {
    const order: string[] = [];
    const privateKey = "PRIVATE-OPENROUTER-KEY";
    const records: ExecutionTimingRecord[] = [];
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 1,
      maxWaitMs: 1_000,
      sink: (event) => {
        if (event.event === "admitted") order.push("admitted");
      },
    });
    const handler = createAgentRequestHandler({
      managedAgentToken: TOKEN,
      agentId: "agent-codex",
      admission,
      sink: (record) => records.push(record),
      resolveProviderConnection: async (reference) => {
        order.push("redeemed");
        expect(reference).toEqual({
          lease: "946c7ed5-ed42-4f26-843f-3e3607722caf",
          run: "signed-run",
        });
        return { provider: "openrouter", apiKey: privateKey };
      },
      respond: (...args) => {
        const [input, _timing, settled] = args;
        order.push("responded");
        expect(args).toHaveLength(3);
        expect(JSON.stringify(input)).not.toContain(privateKey);
        settled();
        return new Response(null, { status: 202 });
      },
    });

    const response = await handler(
      request(
        JSON.stringify({
          threadId: "provider-thread",
          runId: "provider-run",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {
            openbotBotId: "editor",
            openbotCredentialLease: "946c7ed5-ed42-4f26-843f-3e3607722caf",
            openbotRun: "signed-run",
            openbotAdmissionKey: "opaque-admission-key",
            providerEndpoint: "https://attacker.invalid",
            providerToken: "attacker-token",
          },
        }),
      ),
    );

    expect(response.status).toBe(202);
    expect(order).toEqual(["admitted", "redeemed", "responded"]);
    expect(JSON.stringify(records)).not.toContain(privateKey);
    expect(admission.snapshot().active).toBe(0);
  });

  test("rechecks a queued connection and releases admission without starting Codex when it is gone", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 1,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    let settleFirst: (() => void) | undefined;
    let starts = 0;
    let resolutions = 0;
    const handler = createAgentRequestHandler({
      managedAgentToken: TOKEN,
      agentId: "agent-codex",
      admission,
      resolveProviderConnection: async () => {
        resolutions += 1;
        if (resolutions === 2) throw new Error("PRIVATE DISCONNECT DETAIL");
        return { provider: "openrouter", apiKey: "PRIVATE-FIRST-KEY" };
      },
      respond: (_input, _timing, settled) => {
        starts += 1;
        settleFirst = settled;
        return new Response(null, { status: 202 });
      },
    });
    const body = (runId: string, lease: string) =>
      JSON.stringify({
        threadId: `thread-${runId}`,
        runId,
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {
          openbotBotId: "editor",
          openbotCredentialLease: lease,
          openbotRun: `signed-${runId}`,
          openbotAdmissionKey: "opaque-admission-key",
        },
      });

    expect(
      (
        await handler(
          request(body("first", "69d650d9-845f-4ca2-8cc4-9958dd8843c9")),
        )
      ).status,
    ).toBe(202);
    const queued = handler(
      request(body("second", "ac4b3aac-81a2-4684-ad04-76c265724aef")),
    );
    await Bun.sleep(5);
    expect(resolutions).toBe(1);
    expect(starts).toBe(1);

    settleFirst?.();
    const refused = await queued;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Personal AI connection is unavailable.",
    });
    expect(resolutions).toBe(2);
    expect(starts).toBe(1);
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });
});
