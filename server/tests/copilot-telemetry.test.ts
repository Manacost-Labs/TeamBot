import { describe, expect, test } from "bun:test";
import { createStallGuard } from "../src/channels/stall-guard";
import { mountCopilotRuntime } from "../src/copilot";
import {
  createRuntimeRequestTiming,
  type ExecutionTimingRecord,
} from "../src/copilot-telemetry";

describe("Copilot runtime execution timing", () => {
  test("records a correlated monotonic sequence once without request content", async () => {
    const records: ExecutionTimingRecord[] = [];
    const ticks = [100, 112, 119];
    const request = new Request(
      "http://openbot.test/api/copilotkit/agent/codex/run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "codex",
          runId: "run-7",
          threadId: "thread-3",
          messages: [{ role: "user", content: "SECRET PROMPT" }],
          tools: [{ name: "private_tool", arguments: { token: "CREDENTIAL" } }],
          forwardedProps: { openbotRun: "SIGNED ASSERTION" },
        }),
      },
    );

    const timing = await createRuntimeRequestTiming(
      request,
      "/api/copilotkit/agent/codex/run",
      {
        now: () => ticks.shift() ?? 119,
        requestId: () => "request-5",
        sink: (record) => records.push(record),
      },
    );
    timing.record("route_resolved");
    timing.record("route_resolved");
    timing.record("request_accepted");
    timing.record("submit_ack", { status: 202 });

    expect(records).toEqual([
      {
        type: "execution-timing",
        component: "server-runtime",
        phase: "request_received",
        requestId: "request-5",
        runId: "run-7",
        threadId: "thread-3",
        agentId: "codex",
        elapsedMs: 0,
      },
      {
        type: "execution-timing",
        component: "server-runtime",
        phase: "route_resolved",
        requestId: "request-5",
        runId: "run-7",
        threadId: "thread-3",
        agentId: "codex",
        elapsedMs: 12,
      },
      {
        type: "execution-timing",
        component: "server-runtime",
        phase: "request_accepted",
        requestId: "request-5",
        runId: "run-7",
        threadId: "thread-3",
        agentId: "codex",
        elapsedMs: 19,
      },
      {
        type: "execution-timing",
        component: "server-runtime",
        phase: "submit_ack",
        requestId: "request-5",
        runId: "run-7",
        threadId: "thread-3",
        agentId: "codex",
        elapsedMs: 19,
        status: 202,
      },
    ]);

    const serialized = JSON.stringify(records);
    for (const forbidden of [
      "SECRET PROMPT",
      "private_tool",
      "CREDENTIAL",
      "SIGNED ASSERTION",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("omits untrusted identifiers instead of copying them into logs", async () => {
    const records: ExecutionTimingRecord[] = [];
    const request = new Request(
      "http://openbot.test/api/copilotkit/agent/bad%20agent/run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "bad agent\nlog injection",
          runId: { secret: "not-an-id" },
          threadId: "thread with spaces",
        }),
      },
    );

    await createRuntimeRequestTiming(
      request,
      "/api/copilotkit/agent/bad%20agent/run",
      {
        now: () => 10,
        requestId: () => "request-safe",
        sink: (record) => records.push(record),
      },
    );

    expect(records).toEqual([
      {
        type: "execution-timing",
        component: "server-runtime",
        phase: "request_received",
        requestId: "request-safe",
        elapsedMs: 0,
      },
    ]);
  });

  test("prefers the authenticated route agent over a mismatching body id", async () => {
    const records: ExecutionTimingRecord[] = [];
    const request = new Request(
      "http://openbot.test/api/copilotkit/agent/editor/run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "spoofed-agent", runId: "run-8" }),
      },
    );

    await createRuntimeRequestTiming(
      request,
      "/api/copilotkit/agent/editor/run",
      {
        now: () => 10,
        requestId: () => "request-route-agent",
        sink: (record) => records.push(record),
      },
    );

    expect(records[0]).toMatchObject({
      requestId: "request-route-agent",
      runId: "run-8",
      agentId: "editor",
    });
    expect(JSON.stringify(records)).not.toContain("spoofed-agent");
  });

  test("records route resolution, not acceptance, for malformed mounted input", async () => {
    const records: ExecutionTimingRecord[] = [];
    const stallGuard = createStallGuard({ stallMs: 0 });
    const mounted = mountCopilotRuntime(
      {
        accessibility: false,
        computer: undefined,
        runtime: {
          intelligence: {
            apiKey: "test-project-key",
            apiUrl: "http://intelligence.invalid",
            gatewayWsUrl: "ws://intelligence.invalid",
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        now: () => records.length,
        requestId: () => "request-malformed",
        sink: (record) => records.push(record),
      },
    );

    try {
      const response = await mounted.handler.request(
        "http://openbot.test/api/copilotkit/agent/codex/run",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        },
      );
      expect(response.status).toBe(400);
      expect(records.map((record) => record.phase)).toEqual([
        "request_received",
        "route_resolved",
        "submit_ack",
      ]);
      expect(records).not.toContainEqual(
        expect.objectContaining({ phase: "request_accepted" }),
      );
      expect(records.at(-1)?.status).toBe(response.status);
    } finally {
      stallGuard.stop();
    }
  });
});
