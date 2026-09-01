import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptDeviceAuthCoordinator,
  DeviceAuthFlowError,
  type DeviceAuthProcess,
} from "../src/device-auth";
import {
  type CodexRuntimeProfile,
  createCodexRuntimeProfile,
} from "../src/runtime-profile";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const DEVICE_PROMPT = `Open this URL in your browser:\nhttps://auth.openai.com/codex/device\nEnter this one-time code:\nABCD-EFGH\n`;
const AUTH_DOCUMENT = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "device-auth-secret" },
});

const coordinators: ChatGptDeviceAuthCoordinator[] = [];

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((value) => value.shutdown()));
});

function fixture(options: {
  prompt?: string;
  ttlMs?: number;
  readyTimeoutMs?: number;
  profileGate?: Promise<void>;
  ignoreSigterm?: boolean;
  maxFlows?: number;
  terminalRetentionMs?: number;
}) {
  const exits: Deferred<number>[] = [];
  const profiles: CodexRuntimeProfile[] = [];
  let kills = 0;
  const coordinator = new ChatGptDeviceAuthCoordinator({
    ttlMs: options.ttlMs ?? 60_000,
    readyTimeoutMs: options.readyTimeoutMs ?? 1_000,
    terminationGraceMs: 5,
    maxFlows: options.maxFlows,
    terminalRetentionMs: options.terminalRetentionMs,
    createProfile: async () => {
      await options.profileGate;
      const parentDirectory = await mkdtemp(
        join(tmpdir(), "manacost-device-auth-test-"),
      );
      const profile = await createCodexRuntimeProfile({
        parentDirectory,
        environment: { PATH: process.env.PATH },
      });
      profiles.push(profile);
      return profile;
    },
    spawn: () => {
      const exit = deferred<number>();
      exits.push(exit);
      const process: DeviceAuthProcess = {
        stdout: textStream(options.prompt ?? DEVICE_PROMPT),
        stderr: null,
        exited: exit.promise,
        kill(signal = "SIGTERM") {
          kills += 1;
          if (options.ignoreSigterm && signal === "SIGTERM") return;
          exit.resolve(143);
        },
      };
      return process;
    },
  });
  coordinators.push(coordinator);
  return {
    coordinator,
    exits,
    profiles,
    kills: () => kills,
  };
}

async function waitForState(
  coordinator: ChatGptDeviceAuthCoordinator,
  flowId: string,
  state: "completed" | "failed" | "cancelled" | "expired",
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await coordinator.status(flowId)).state === state) return;
    await Bun.sleep(5);
  }
  throw new Error(`device auth flow did not reach ${state}`);
}

describe("ChatGPT device authentication coordinator", () => {
  test("returns only safe public instructions and reserves completion for the collector", async () => {
    const fixtureState = fixture({});
    const started = await fixtureState.coordinator.start();

    expect(Object.keys(started).sort()).toEqual([
      "expiresAt",
      "flowId",
      "userCode",
      "verificationUrl",
    ]);
    expect(started.verificationUrl).toBe(
      "https://auth.openai.com/codex/device",
    );
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(started)).not.toContain("device-auth-secret");

    const profile = fixtureState.profiles[0];
    expect(profile).toBeDefined();
    await writeFile(join(profile!.codexHome, "auth.json"), AUTH_DOCUMENT, {
      mode: 0o600,
    });
    fixtureState.exits[0]?.resolve(0);
    await waitForState(fixtureState.coordinator, started.flowId, "completed");

    const status = await fixtureState.coordinator.status(started.flowId);
    expect(status).toEqual({
      flowId: started.flowId,
      state: "completed",
      expiresAt: started.expiresAt,
    });
    expect(JSON.stringify(status)).not.toContain("device-auth-secret");
    await expect(
      fixtureState.coordinator.collect(started.flowId),
    ).resolves.toEqual({ provider: "chatgpt", authDocument: AUTH_DOCUMENT });
    await expect(access(profile!.codexHome)).rejects.toThrow();
  });

  test("refuses a duplicate flow without starting a second child", async () => {
    const fixtureState = fixture({});
    const flowId = "11111111-1111-4111-8111-111111111111";
    await fixtureState.coordinator.start(flowId);

    await expect(fixtureState.coordinator.start(flowId)).rejects.toMatchObject({
      code: "duplicate_flow",
    });
    expect(fixtureState.exits).toHaveLength(1);
  });

  test("reserves a requested flow id before asynchronous profile creation", async () => {
    const profileGate = deferred<void>();
    const fixtureState = fixture({ profileGate: profileGate.promise });
    const flowId = "22222222-2222-4222-8222-222222222222";

    const first = fixtureState.coordinator.start(flowId);
    const duplicate = fixtureState.coordinator.start(flowId);
    const duplicateRefusal = expect(duplicate).rejects.toMatchObject({
      code: "duplicate_flow",
    });
    profileGate.resolve();

    await expect(first).resolves.toMatchObject({ flowId });
    await duplicateRefusal;
    expect(fixtureState.exits).toHaveLength(1);
  });

  test("bounds concurrent and retained flows, then purges terminal status", async () => {
    const fixtureState = fixture({ maxFlows: 1, terminalRetentionMs: 10 });
    const first = await fixtureState.coordinator.start(
      "44444444-4444-4444-8444-444444444444",
    );

    await expect(
      fixtureState.coordinator.start("55555555-5555-4555-8555-555555555555"),
    ).rejects.toMatchObject({ code: "flow_capacity" });

    await fixtureState.coordinator.cancel(first.flowId);
    expect((await fixtureState.coordinator.status(first.flowId)).state).toBe(
      "cancelled",
    );
    await Bun.sleep(20);
    await expect(
      fixtureState.coordinator.status(first.flowId),
    ).rejects.toMatchObject({ code: "flow_unavailable" });

    await expect(
      fixtureState.coordinator.start("55555555-5555-4555-8555-555555555555"),
    ).resolves.toMatchObject({
      flowId: "55555555-5555-4555-8555-555555555555",
    });
  });

  test("accepts only the fixed official verification path", async () => {
    const fixtureState = fixture({
      prompt: "Open https://auth.openai.com/unrelated and enter ABCD-EFGH\n",
      readyTimeoutMs: 10,
    });

    await expect(fixtureState.coordinator.start()).rejects.toMatchObject({
      code: "process_failed",
    });
    await expect(access(fixtureState.profiles[0]!.codexHome)).rejects.toThrow();
  });

  test("timeout kills the child, purges its home and exposes no auth material", async () => {
    const fixtureState = fixture({ ttlMs: 20 });
    const started = await fixtureState.coordinator.start();
    const home = fixtureState.profiles[0]?.codexHome;
    expect(home).toBeDefined();

    await waitForState(fixtureState.coordinator, started.flowId, "expired");
    expect(fixtureState.kills()).toBe(1);
    await expect(access(home!)).rejects.toThrow();
    await expect(
      fixtureState.coordinator.collect(started.flowId),
    ).rejects.toBeInstanceOf(DeviceAuthFlowError);
  });

  test("cancel is idempotent and removes the flow-owned child and home", async () => {
    const fixtureState = fixture({});
    const started = await fixtureState.coordinator.start();
    const home = fixtureState.profiles[0]?.codexHome;

    await expect(
      fixtureState.coordinator.cancel(started.flowId),
    ).resolves.toEqual({
      flowId: started.flowId,
      state: "cancelled",
      expiresAt: started.expiresAt,
    });
    await expect(
      fixtureState.coordinator.cancel(started.flowId),
    ).resolves.toEqual({
      flowId: started.flowId,
      state: "cancelled",
      expiresAt: started.expiresAt,
    });
    expect(fixtureState.kills()).toBe(1);
    await expect(access(home!)).rejects.toThrow();
  });

  test("forces a child that ignores graceful cancellation to exit", async () => {
    const fixtureState = fixture({ ignoreSigterm: true });
    const started = await fixtureState.coordinator.start();
    const home = fixtureState.profiles[0]?.codexHome;

    await fixtureState.coordinator.cancel(started.flowId);

    expect(fixtureState.kills()).toBe(2);
    await expect(access(home!)).rejects.toThrow();
  });

  test("refuses an auth.json symlink even when it targets valid JSON", async () => {
    const fixtureState = fixture({});
    const started = await fixtureState.coordinator.start();
    const profile = fixtureState.profiles[0];
    expect(profile).toBeDefined();
    const foreignDirectory = await mkdtemp(
      join(tmpdir(), "manacost-device-auth-foreign-"),
    );
    const foreignAuth = join(foreignDirectory, "auth.json");

    try {
      await writeFile(foreignAuth, AUTH_DOCUMENT, { mode: 0o600 });
      await symlink(foreignAuth, join(profile!.codexHome, "auth.json"));
      fixtureState.exits[0]?.resolve(0);
      await waitForState(fixtureState.coordinator, started.flowId, "failed");

      await expect(
        fixtureState.coordinator.collect(started.flowId),
      ).rejects.toMatchObject({ code: "flow_unavailable" });
    } finally {
      await rm(foreignDirectory, { recursive: true, force: true });
    }
  });

  test("a process failure is a bounded public state with no output echo", async () => {
    const canary = "process-output-secret";
    const fixtureState = fixture({
      prompt: `${DEVICE_PROMPT}${canary}`,
    });
    const started = await fixtureState.coordinator.start();
    fixtureState.exits[0]?.resolve(1);
    await waitForState(fixtureState.coordinator, started.flowId, "failed");

    const status = await fixtureState.coordinator.status(started.flowId);
    expect(JSON.stringify(status)).not.toContain(canary);
    await expect(
      fixtureState.coordinator.collect(started.flowId),
    ).rejects.toMatchObject({ code: "flow_unavailable" });
  });

  test("shutdown terminates every pending child and rejects new starts", async () => {
    const fixtureState = fixture({});
    const first = await fixtureState.coordinator.start();
    const second = await fixtureState.coordinator.start();

    await fixtureState.coordinator.shutdown();
    expect(fixtureState.kills()).toBe(2);
    expect((await fixtureState.coordinator.status(first.flowId)).state).toBe(
      "cancelled",
    );
    expect((await fixtureState.coordinator.status(second.flowId)).state).toBe(
      "cancelled",
    );
    await expect(fixtureState.coordinator.start()).rejects.toMatchObject({
      code: "service_stopped",
    });
  });

  test("shutdown waits for an in-flight profile creation and removes its home", async () => {
    const profileGate = deferred<void>();
    const fixtureState = fixture({ profileGate: profileGate.promise });
    const starting = fixtureState.coordinator.start(
      "66666666-6666-4666-8666-666666666666",
    );
    let shutdownSettled = false;
    const shutdown = fixtureState.coordinator.shutdown().then(() => {
      shutdownSettled = true;
    });

    await Bun.sleep(0);
    expect(shutdownSettled).toBe(false);
    profileGate.resolve();

    await shutdown;
    await expect(starting).rejects.toMatchObject({ code: "service_stopped" });
    expect(fixtureState.exits).toHaveLength(0);
    expect(fixtureState.profiles).toHaveLength(1);
    await expect(access(fixtureState.profiles[0]!.codexHome)).rejects.toThrow();
  });

  test("shutdown clears a completed auth document and no longer reports completion", async () => {
    const fixtureState = fixture({});
    const started = await fixtureState.coordinator.start();
    const profile = fixtureState.profiles[0]!;
    await writeFile(join(profile.codexHome, "auth.json"), AUTH_DOCUMENT, {
      mode: 0o600,
    });
    fixtureState.exits[0]?.resolve(0);
    await waitForState(fixtureState.coordinator, started.flowId, "completed");

    await fixtureState.coordinator.shutdown();

    expect((await fixtureState.coordinator.status(started.flowId)).state).toBe(
      "cancelled",
    );
    await expect(
      fixtureState.coordinator.collect(started.flowId),
    ).rejects.toMatchObject({ code: "flow_unavailable" });
  });
});
