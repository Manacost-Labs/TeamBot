import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAgentResponse } from "../src/agent-run";
import {
  ChatGptProfileUnavailableError,
  createChatGptRuntimeProfile,
} from "../src/chatgpt-profile";
import { runCodex } from "../src/codex-run";
import { createAgentRequestHandler } from "../src/request-handler";

const INITIAL_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "initial-access-token-canary",
    refresh_token: "initial-refresh-token-canary",
    id_token: "initial-id-token-canary",
  },
  last_refresh: "2026-09-01T00:00:00.000Z",
});

const REFRESHED_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "refreshed-access-token-canary",
    refresh_token: "refreshed-refresh-token-canary",
    id_token: "refreshed-id-token-canary",
  },
  last_refresh: "2026-09-01T00:01:00.000Z",
});

const profiles: Array<Awaited<ReturnType<typeof createChatGptRuntimeProfile>>> =
  [];

afterEach(async () => {
  await Promise.all(profiles.splice(0).map((profile) => profile.dispose()));
});

describe("per-run ChatGPT profile", () => {
  test("materialises only a validated auth.json in its private CODEX_HOME", async () => {
    const profile = await createChatGptRuntimeProfile({
      authDocument: INITIAL_AUTH,
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: "/host/.codex",
        CODEX_AUTH_PATH: "/host/.codex/auth.json",
        OPENAI_API_KEY: "host-fallback-secret",
      },
    });
    profiles.push(profile);

    const authPath = join(profile.codexHome, "auth.json");
    expect((await stat(profile.codexHome)).mode & 0o777).toBe(0o700);
    expect((await lstat(authPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(authPath, "utf8")).toBe(INITIAL_AUTH);
    expect(profile.environment).toEqual({
      PATH: process.env.PATH,
      CODEX_HOME: profile.codexHome,
    });
    expect(profile.environment.CODEX_AUTH_PATH).toBeUndefined();
    expect(profile.environment.OPENAI_API_KEY).toBeUndefined();
    expect(await profile.readChangedAuthDocument()).toBeNull();
  });

  test("carries trusted request provenance through AG-UI and refreshes after the real run settles", async () => {
    const managedToken = "task-25-managed-token";
    const lease = "8f1dd4f8-5311-48c2-ac71-7ae00ee69a63";
    const signedRun = "task-25-signed-run";
    const refreshes: unknown[] = [];
    const handler = createAgentRequestHandler({
      managedAgentToken: managedToken,
      agentId: "agent-codex",
      resolveProviderConnection: async (reference) => {
        expect(reference).toEqual({ lease, run: signedRun });
        return { provider: "chatgpt", authDocument: INITIAL_AUTH };
      },
      refreshProviderConnection: async (reference, authDocument) => {
        refreshes.push({ reference, authDocument });
      },
      respond: (input, timing, onSettled, provider) =>
        createAgentResponse(input, {
          timing,
          onSettled,
          providerConnection: provider.connection,
          providerConnectionReference: provider.reference,
          refreshProviderConnection: provider.refresh,
          run: (runInput, callbacks, runTiming) =>
            runCodex(runInput, callbacks, {
              timing: runTiming,
              providerConnection: provider.connection,
              providerConnectionReference: provider.reference,
              refreshProviderConnection: provider.refresh,
              spawn: (profile) => {
                writeFileSync(
                  join(profile.codexHome, "auth.json"),
                  REFRESHED_AUTH,
                  { mode: 0o600 },
                );
                return protocolChild();
              },
            }),
        }),
    });

    const response = await handler(
      new Request("http://agent.test/ag-ui", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": managedToken,
        },
        body: JSON.stringify({
          threadId: "task-25-thread",
          runId: "task-25-run",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {
            openbotBotId: "editor",
            openbotAdmissionKey: `oba_${"A".repeat(43)}`,
            openbotCredentialLease: lease,
            openbotRun: signedRun,
          },
        }),
      }),
    );
    const events = await response.text();

    expect(response.status).toBe(200);
    expect(events).toContain("RUN_STARTED");
    expect(events).toContain("RUN_FINISHED");
    for (const secret of [
      "initial-access-token-canary",
      "initial-refresh-token-canary",
      "initial-id-token-canary",
      "refreshed-access-token-canary",
      "refreshed-refresh-token-canary",
      "refreshed-id-token-canary",
    ]) {
      expect(events).not.toContain(secret);
    }
    expect(refreshes).toEqual([
      {
        reference: { lease, run: signedRun },
        authDocument: REFRESHED_AUTH,
      },
    ]);
  });

  test("returns a changed valid document only after a safe no-follow read", async () => {
    const profile = await createChatGptRuntimeProfile({
      authDocument: INITIAL_AUTH,
    });
    profiles.push(profile);
    const authPath = join(profile.codexHome, "auth.json");

    await writeFile(authPath, REFRESHED_AUTH, { mode: 0o600 });

    expect(await profile.readChangedAuthDocument()).toBe(REFRESHED_AUTH);
  });

  test("rejects missing, malformed, revoked, linked and broadly-readable auth state with Settings guidance", async () => {
    const malformed = [
      "{}",
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "missing-refresh-token" },
      }),
      JSON.stringify({
        auth_mode: "api_key",
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      }),
    ];
    for (const authDocument of malformed) {
      await expect(
        createChatGptRuntimeProfile({ authDocument }),
      ).rejects.toBeInstanceOf(ChatGptProfileUnavailableError);
    }

    const missing = await createChatGptRuntimeProfile({
      authDocument: INITIAL_AUTH,
    });
    profiles.push(missing);
    await rm(join(missing.codexHome, "auth.json"));
    await expect(missing.readChangedAuthDocument()).rejects.toThrow(
      "Reconnect ChatGPT in Settings",
    );

    const invalid = await createChatGptRuntimeProfile({
      authDocument: INITIAL_AUTH,
    });
    profiles.push(invalid);
    await writeFile(join(invalid.codexHome, "auth.json"), "{}", {
      mode: 0o600,
    });
    await expect(invalid.readChangedAuthDocument()).rejects.toBeInstanceOf(
      ChatGptProfileUnavailableError,
    );

    const broad = await createChatGptRuntimeProfile({
      authDocument: INITIAL_AUTH,
    });
    profiles.push(broad);
    await chmod(join(broad.codexHome, "auth.json"), 0o644);
    await expect(broad.readChangedAuthDocument()).rejects.toBeInstanceOf(
      ChatGptProfileUnavailableError,
    );

    const linked = await createChatGptRuntimeProfile({
      authDocument: INITIAL_AUTH,
    });
    profiles.push(linked);
    const authPath = join(linked.codexHome, "auth.json");
    const target = join(linked.codexHome, "foreign-auth.json");
    await writeFile(target, REFRESHED_AUTH, { mode: 0o600 });
    await rm(authPath);
    await symlink(target, authPath);
    await expect(linked.readChangedAuthDocument()).rejects.toBeInstanceOf(
      ChatGptProfileUnavailableError,
    );
  });

  test("removes plaintext after success and remains idempotent", async () => {
    const profile = await createChatGptRuntimeProfile({
      authDocument: INITIAL_AUTH,
    });
    const authPath = join(profile.codexHome, "auth.json");
    const handle = await open(authPath, constants.O_RDONLY);
    await handle.close();

    await profile.dispose();
    await profile.dispose();

    await expect(access(profile.codexHome)).rejects.toThrow();
  });
});

function protocolChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", 0, signal));
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
        ? { thread: { id: "task-25-codex-thread" } }
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
