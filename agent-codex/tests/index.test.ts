import { describe, expect, test } from "bun:test";
import type {
  DeviceAuthPublicStatus,
  DeviceAuthStartResult,
} from "../src/device-auth";
import { DeviceAuthFlowError } from "../src/device-auth";
import {
  createAgentCodexService,
  DEVICE_AUTH_PATHS,
  type DeviceAuthCoordinator,
} from "../src/index";
import { RunAdmission } from "../src/run-admission";

const TOKEN = "managed-device-auth-token";
const FLOW_ID = "33333333-3333-4333-8333-333333333333";
const AUTH_DOCUMENT = '{"tokens":{"access_token":"collector-only-secret"}}';

function admission() {
  return new RunAdmission({
    globalLimit: 2,
    perAgentLimit: 1,
    queueLimit: 2,
    maxWaitMs: 1_000,
    sink: () => {},
  });
}

function deviceAuthFixture(): DeviceAuthCoordinator & {
  calls: Array<{ operation: string; flowId?: string }>;
  shutdowns: number;
} {
  const calls: Array<{ operation: string; flowId?: string }> = [];
  const pending: DeviceAuthPublicStatus = {
    flowId: FLOW_ID,
    state: "pending",
    expiresAt: "2026-09-01T00:15:00.000Z",
  };
  const started: DeviceAuthStartResult = {
    flowId: FLOW_ID,
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    expiresAt: pending.expiresAt,
  };
  return {
    calls,
    shutdowns: 0,
    async start(flowId) {
      calls.push({ operation: "start", flowId });
      return { ...started, flowId: flowId ?? FLOW_ID };
    },
    async status(flowId) {
      calls.push({ operation: "status", flowId });
      return { ...pending, flowId };
    },
    async cancel(flowId) {
      calls.push({ operation: "cancel", flowId });
      return { ...pending, flowId, state: "cancelled" };
    },
    async collect(flowId) {
      calls.push({ operation: "collect", flowId });
      return { provider: "chatgpt", authDocument: AUTH_DOCUMENT };
    },
    async shutdown() {
      this.shutdowns += 1;
    },
  };
}

function internalRequest(
  path: string,
  options: {
    body?: string;
    method?: string;
    token?: string;
    contentType?: string;
  } = {},
) {
  return new Request(`http://agent.test${path}`, {
    method: options.method ?? "POST",
    headers: {
      ...(options.token === undefined
        ? {}
        : { "x-openbot-agent-token": options.token }),
      ...(options.contentType === undefined
        ? { "content-type": "application/json" }
        : { "content-type": options.contentType }),
    },
    body:
      (options.method ?? "POST") === "GET"
        ? undefined
        : (options.body ?? JSON.stringify({ flowId: FLOW_ID })),
  });
}

describe("agent-codex internal device-auth boundary", () => {
  test("requires the managed token before every device operation", async () => {
    const deviceAuth = deviceAuthFixture();
    const service = createAgentCodexService({
      managedAgentToken: TOKEN,
      admission: admission(),
      deviceAuth,
    });

    for (const path of Object.values(DEVICE_AUTH_PATHS)) {
      const response = await service.fetch(internalRequest(path));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized." });
    }
    expect(deviceAuth.calls).toEqual([]);
    await service.shutdown();
  });

  test("accepts only exact POST paths and strict bounded JSON", async () => {
    const deviceAuth = deviceAuthFixture();
    const service = createAgentCodexService({
      managedAgentToken: TOKEN,
      admission: admission(),
      deviceAuth,
    });

    const wrongMethod = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.status, {
        method: "GET",
        token: TOKEN,
      }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const wrongPath = await service.fetch(
      internalRequest(`${DEVICE_AUTH_PATHS.status}/`, { token: TOKEN }),
    );
    expect(wrongPath.status).toBe(404);

    const queryPath = await service.fetch(
      internalRequest(`${DEVICE_AUTH_PATHS.status}?flowId=${FLOW_ID}`, {
        token: TOKEN,
      }),
    );
    expect(queryPath.status).toBe(404);

    const wrongType = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.status, {
        token: TOKEN,
        contentType: "text/plain",
      }),
    );
    expect(wrongType.status).toBe(415);

    const extraField = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.status, {
        token: TOKEN,
        body: JSON.stringify({ flowId: FLOW_ID, actorId: "must-not-cross" }),
      }),
    );
    expect(extraField.status).toBe(400);

    const oversized = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.start, {
        token: TOKEN,
        body: JSON.stringify({ padding: "x".repeat(5_000) }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(deviceAuth.calls).toEqual([]);
    await service.shutdown();
  });

  test("projects safe start/status/cancel results and reserves auth material for collect", async () => {
    const deviceAuth = deviceAuthFixture();
    const service = createAgentCodexService({
      managedAgentToken: TOKEN,
      admission: admission(),
      deviceAuth,
    });

    const start = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.start, {
        token: TOKEN,
        body: JSON.stringify({ flowId: FLOW_ID }),
      }),
    );
    expect(start.status).toBe(201);
    const startText = await start.text();
    expect(JSON.parse(startText)).toMatchObject({
      flowId: FLOW_ID,
      userCode: "ABCD-EFGH",
    });

    const status = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.status, { token: TOKEN }),
    );
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(JSON.parse(statusText)).toEqual({
      flowId: FLOW_ID,
      state: "pending",
      expiresAt: "2026-09-01T00:15:00.000Z",
    });

    const cancelled = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.cancel, { token: TOKEN }),
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ state: "cancelled" });

    expect(`${startText}${statusText}`).not.toContain("collector-only-secret");

    const collected = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.collect, { token: TOKEN }),
    );
    expect(collected.status).toBe(200);
    expect(await collected.json()).toEqual({
      provider: "chatgpt",
      authDocument: AUTH_DOCUMENT,
    });
    expect(deviceAuth.calls).toEqual([
      { operation: "start", flowId: FLOW_ID },
      { operation: "status", flowId: FLOW_ID },
      { operation: "cancel", flowId: FLOW_ID },
      { operation: "collect", flowId: FLOW_ID },
    ]);
    await service.shutdown();
  });

  test("permits an internally generated start id and shuts down exactly once", async () => {
    const deviceAuth = deviceAuthFixture();
    const service = createAgentCodexService({
      managedAgentToken: TOKEN,
      admission: admission(),
      deviceAuth,
    });

    const response = await service.fetch(
      internalRequest(DEVICE_AUTH_PATHS.start, {
        token: TOKEN,
        body: "{}",
      }),
    );
    expect(response.status).toBe(201);
    expect(deviceAuth.calls).toEqual([
      { operation: "start", flowId: undefined },
    ]);

    await service.shutdown();
    await service.shutdown();
    expect(deviceAuth.shutdowns).toBe(1);
    expect(service.admission.snapshot().draining).toBe(true);
  });

  test("maps coordinator failures to bounded errors without echoing child output", async () => {
    const capacity = deviceAuthFixture();
    capacity.start = async () => {
      throw new DeviceAuthFlowError("flow_capacity");
    };
    const capacityService = createAgentCodexService({
      managedAgentToken: TOKEN,
      admission: admission(),
      deviceAuth: capacity,
    });
    const refused = await capacityService.fetch(
      internalRequest(DEVICE_AUTH_PATHS.start, {
        token: TOKEN,
        body: "{}",
      }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toEqual({
      error: "Device authentication request failed.",
      code: "flow_capacity",
    });
    await capacityService.shutdown();

    const failed = deviceAuthFixture();
    failed.status = async () => {
      throw new Error("child-output-secret");
    };
    const failedService = createAgentCodexService({
      managedAgentToken: TOKEN,
      admission: admission(),
      deviceAuth: failed,
    });
    const response = await failedService.fetch(
      internalRequest(DEVICE_AUTH_PATHS.status, { token: TOKEN }),
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("child-output-secret");
    expect(JSON.parse(text)).toEqual({
      error: "Device authentication request failed.",
    });
    await failedService.shutdown();
  });
});
