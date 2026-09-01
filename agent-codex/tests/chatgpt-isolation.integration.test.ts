import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { RunAgentInput } from "@ag-ui/core";
import { runCodex } from "../src/codex-run";
import {
  ChatGptDeviceAuthCoordinator,
  type DeviceAuthProcess,
} from "../src/device-auth";
import {
  type CodexRuntimeProfile,
  createCodexRuntimeProfile,
} from "../src/runtime-profile";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

const callbacks = {
  onText() {},
  onReasoning() {},
  onToolStart() {},
  onToolResult() {},
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

function authDocument(actor: string, generation = "initial") {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: `${actor}-${generation}-access-canary`,
      refresh_token: `${actor}-${generation}-refresh-canary`,
      id_token: `${actor}-${generation}-id-canary`,
    },
  });
}

function runInput(actor: string, runId: string): RunAgentInput {
  return {
    agentId: "shared-chatgpt-employee",
    runId,
    threadId: `thread-${actor}`,
    state: {},
    context: [],
    messages: [
      {
        id: `message-${actor}`,
        role: "user",
        content: `Private task for ${actor}`,
      },
    ],
    tools: [],
    forwardedProps: {
      openbotBotId: "shared-chatgpt-employee",
      openbotRun: `signed-${actor}-${runId}`,
    },
  } as unknown as RunAgentInput;
}

function successfulChild(label: string): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    queueMicrotask(() => {
      child.emit("exit", 0, signal);
      child.emit("close", 0, signal);
    });
    return true;
  };
  queueMicrotask(() => child.emit("spawn"));
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as {
      id?: number;
      method?: string;
    };
    if (request.id === undefined) return;
    const result =
      request.method === "thread/start"
        ? { thread: { id: `thread-${label}` } }
        : request.method === "turn/start"
          ? { turn: { id: `turn-${label}` } }
          : {};
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "turn/start") {
        child.stdout.write(
          `${JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } })}\n`,
        );
      }
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function failingChild(secret: string): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as FakeChild;
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
    child.stderr.write(`forced child exit echoed ${secret}`);
    queueMicrotask(() => {
      child.emit("exit", 17, null);
      child.emit("close", 17, null);
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function absent(path: string) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

async function waitForCompleted(
  coordinator: ChatGptDeviceAuthCoordinator,
  flowId: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await coordinator.status(flowId)).state === "completed") return;
    await Bun.sleep(5);
  }
  throw new Error("device auth fixture did not complete");
}

describe("ChatGPT runtime lifecycle isolation", () => {
  test("runs two actors in distinct private profiles and refreshes only their own reference", async () => {
    const actors = ["actor-a", "actor-b"] as const;
    const initial = actors.map((actor) => authDocument(actor));
    const refreshed = actors.map((actor) => authDocument(actor, "refreshed"));
    const homes: string[] = [];
    const observedDocuments: string[] = [];
    const refreshes: Array<{
      actor: string;
      reference: unknown;
      authDocument: string;
    }> = [];

    await Promise.all(
      actors.map((actor, index) =>
        runCodex(runInput(actor, `run-${index}`), callbacks, {
          providerConnection: {
            provider: "chatgpt",
            authDocument: initial[index]!,
          },
          providerConnectionReference: {
            lease:
              index === 0
                ? "11111111-1111-4111-8111-111111111111"
                : "22222222-2222-4222-8222-222222222222",
            run: `signed-${actor}-run-${index}`,
          },
          refreshProviderConnection: async (reference, authDocument) => {
            refreshes.push({ actor, reference, authDocument });
          },
          environment: {
            PATH: process.env.PATH,
            CODEX_HOME: "/host/.codex",
            CODEX_AUTH_PATH: "/host/.codex/auth.json",
            OPENAI_API_KEY: "host-fallback-must-not-be-used",
          },
          spawn: (profile) => {
            homes[index] = profile.codexHome;
            observedDocuments[index] = readFileSync(
              `${profile.codexHome}/auth.json`,
              "utf8",
            );
            expect(profile.environment).toEqual({
              PATH: process.env.PATH,
              CODEX_HOME: profile.codexHome,
            });
            writeFileSync(`${profile.codexHome}/auth.json`, refreshed[index]!, {
              mode: 0o600,
            });
            return successfulChild(actor);
          },
        }),
      ),
    );

    expect(new Set(homes).size).toBe(2);
    expect(observedDocuments).toEqual(initial);
    expect(await Promise.all(homes.map(absent))).toEqual([true, true]);
    expect(
      refreshes.sort((left, right) => left.actor.localeCompare(right.actor)),
    ).toEqual([
      {
        actor: "actor-a",
        reference: {
          lease: "11111111-1111-4111-8111-111111111111",
          run: "signed-actor-a-run-0",
        },
        authDocument: refreshed[0],
      },
      {
        actor: "actor-b",
        reference: {
          lease: "22222222-2222-4222-8222-222222222222",
          run: "signed-actor-b-run-1",
        },
        authDocument: refreshed[1],
      },
    ]);
  });

  test("wipes completed login state across restart and a forced run exit", async () => {
    const deviceProfiles: CodexRuntimeProfile[] = [];
    const deviceExit = deferred<number>();
    const coordinator = new ChatGptDeviceAuthCoordinator({
      ttlMs: 60_000,
      readyTimeoutMs: 1_000,
      terminationGraceMs: 5,
      createProfile: async () => {
        const profile = await createCodexRuntimeProfile({
          environment: { PATH: process.env.PATH },
        });
        deviceProfiles.push(profile);
        return profile;
      },
      spawn: () =>
        ({
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  "Open https://auth.openai.com/codex/device and enter ABCD-EFGH\n",
                ),
              );
              controller.close();
            },
          }),
          stderr: null,
          exited: deviceExit.promise,
          kill() {
            deviceExit.resolve(143);
          },
        }) satisfies DeviceAuthProcess,
    });
    const restarted = new ChatGptDeviceAuthCoordinator();
    const flowId = "33333333-3333-4333-8333-333333333333";
    const deviceDocument = authDocument("device-owner");
    try {
      const started = await coordinator.start(flowId);
      const deviceHome = deviceProfiles[0]!.codexHome;
      await writeFile(`${deviceHome}/auth.json`, deviceDocument, {
        mode: 0o600,
      });
      deviceExit.resolve(0);
      await waitForCompleted(coordinator, started.flowId);
      await expect(coordinator.collect(started.flowId)).resolves.toEqual({
        provider: "chatgpt",
        authDocument: deviceDocument,
      });

      await coordinator.shutdown();
      expect((await coordinator.status(started.flowId)).state).toBe(
        "cancelled",
      );
      await expect(coordinator.collect(started.flowId)).rejects.toMatchObject({
        code: "flow_unavailable",
      });
      await expect(restarted.status(started.flowId)).rejects.toMatchObject({
        code: "flow_unavailable",
      });
      expect(await absent(deviceHome)).toBe(true);

      const runDocument = authDocument("forced-run");
      let runHome = "";
      let refreshCalls = 0;
      let thrown: unknown;
      try {
        await runCodex(runInput("forced-run", "run-failed"), callbacks, {
          providerConnection: {
            provider: "chatgpt",
            authDocument: runDocument,
          },
          providerConnectionReference: {
            lease: "44444444-4444-4444-8444-444444444444",
            run: "signed-forced-run",
          },
          refreshProviderConnection: async () => {
            refreshCalls += 1;
          },
          environment: { PATH: process.env.PATH },
          spawn: (profile) => {
            runHome = profile.codexHome;
            return failingChild("forced-run-initial-access-canary");
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain("[redacted]");
      expect(String(thrown)).not.toContain("forced-run-initial-access-canary");
      expect(String(thrown)).not.toContain(runDocument);
      expect(refreshCalls).toBe(0);
      expect(await absent(runHome)).toBe(true);
    } finally {
      await coordinator.shutdown();
      await restarted.shutdown();
    }
  });
});
