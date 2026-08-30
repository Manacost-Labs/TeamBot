import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createWorkspaceTelemetryRoutes,
  createWorkspaceTimingIngestLimiter,
  createWorkspaceTimingStore,
  parseWorkspaceTimingBatch,
  type WorkspaceTimingRecord,
} from "../src/workspace-telemetry";

function requireUser(
  role: "admin" | "user" = "admin",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "person-1",
      email: "person@example.test",
      role,
    });
    await next();
  };
}

function sample(elapsedMs: number) {
  return {
    operation: "channel_switch" as const,
    phase: "cached_history_painted" as const,
    traceId: "00000000-0000-4000-8000-000000000001",
    elapsedMs,
  };
}

describe("workspace timing aggregation", () => {
  test("keeps bounded samples and reports nearest-rank percentiles", () => {
    const store = createWorkspaceTimingStore({
      maxSamplesPerMetric: 3,
      sink: () => {},
    });
    store.recordMany([sample(10), sample(20), sample(30), sample(40)]);

    expect(store.snapshot()).toEqual([
      {
        operation: "channel_switch",
        phase: "cached_history_painted",
        count: 3,
        p50: 30,
        p95: 40,
        p99: 40,
      },
    ]);
  });

  test("rejects extra fields and operation/phase mismatches", () => {
    expect(
      parseWorkspaceTimingBatch({
        samples: [{ ...sample(12), content: "private conversation" }],
      }),
    ).toBeNull();
    expect(
      parseWorkspaceTimingBatch({
        samples: [
          {
            ...sample(12),
            operation: "agent_run",
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseWorkspaceTimingBatch({
        samples: [
          {
            ...sample(12),
            traceId: "private-conversation-customer-token-ABC123",
          },
        ],
      }),
    ).toBeNull();
  });

  test("falls back to a finite bound when an invalid limit is supplied", () => {
    const store = createWorkspaceTimingStore({
      maxSamplesPerMetric: Number.NaN,
      sink: () => {},
    });
    store.recordMany(Array.from({ length: 600 }, (_, index) => sample(index)));
    expect(store.snapshot()[0]?.count).toBe(512);
  });
});

describe("workspace timing routes", () => {
  test("accepts authenticated content-free batches and exposes an admin summary", async () => {
    const records: WorkspaceTimingRecord[] = [];
    const store = createWorkspaceTimingStore({
      sink: (record) => records.push(record),
    });
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/telemetry",
      createWorkspaceTelemetryRoutes(requireUser(), store),
    );

    const accepted = await app.request(
      "http://openbot.test/api/telemetry/workspace",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ samples: [sample(25)] }),
      },
    );
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({ accepted: 1 });
    expect(records).toEqual([
      {
        type: "workspace-timing",
        component: "frontend",
        ...sample(25),
      },
    ]);

    const summary = await app.request(
      "http://openbot.test/api/telemetry/workspace/summary",
    );
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toEqual({
      metrics: [
        {
          operation: "channel_switch",
          phase: "cached_history_painted",
          count: 1,
          p50: 25,
          p95: 25,
          p99: 25,
        },
      ],
    });
  });

  test("keeps summaries administrator-only", async () => {
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/telemetry",
      createWorkspaceTelemetryRoutes(
        requireUser("user"),
        createWorkspaceTimingStore({ sink: () => {} }),
      ),
    );
    const response = await app.request(
      "http://openbot.test/api/telemetry/workspace/summary",
    );
    expect(response.status).toBe(403);
  });

  test("rate limits each actor before logs or aggregates are mutated", async () => {
    const records: WorkspaceTimingRecord[] = [];
    const store = createWorkspaceTimingStore({
      sink: (record) => records.push(record),
    });
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/telemetry",
      createWorkspaceTelemetryRoutes(requireUser(), store, {
        limiter: createWorkspaceTimingIngestLimiter({
          maxSamplesPerWindow: 1,
          windowMs: 60_000,
        }),
      }),
    );
    const request = () =>
      app.request("http://openbot.test/api/telemetry/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ samples: [sample(25)] }),
      });

    expect((await request()).status).toBe(202);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(records).toHaveLength(1);
    expect(store.snapshot()[0]?.count).toBe(1);
  });

  test("rejects an oversized body before parsing or recording it", async () => {
    const records: WorkspaceTimingRecord[] = [];
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/telemetry",
      createWorkspaceTelemetryRoutes(
        requireUser(),
        createWorkspaceTimingStore({
          sink: (record) => records.push(record),
        }),
        { maxBodyBytes: 128 },
      ),
    );
    const response = await app.request(
      "http://openbot.test/api/telemetry/workspace",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          samples: [sample(25)],
          padding: "x".repeat(256),
        }),
      },
    );

    expect(response.status).toBe(413);
    expect(records).toHaveLength(0);
  });
});
