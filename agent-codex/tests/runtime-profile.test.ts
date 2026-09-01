import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import {
  type CodexRuntimeProfile,
  createCodexRuntimeProfile,
  createOpenRouterRuntimeProfile,
  OPENROUTER_API_KEY_ENVIRONMENT_KEY,
  OPENROUTER_BASE_URL,
} from "../src/runtime-profile";

const profiles: CodexRuntimeProfile[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(profiles.splice(0).map((profile) => profile.dispose()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Codex runtime profile", () => {
  it("creates a private task-owned CODEX_HOME from an environment allowlist", async () => {
    const parentDirectory = await mkdtemp(
      join(tmpdir(), "openbot-profile-test-"),
    );
    temporaryRoots.push(parentDirectory);

    const profile = await createCodexRuntimeProfile({
      parentDirectory,
      environment: {
        PATH: "/usr/local/bin:/usr/bin",
        LANG: "C.UTF-8",
        CODEX_HOME: "/host/.codex",
        CODEX_AUTH_PATH: "/host/.codex/auth.json",
        HOME: "/host",
        OPENAI_API_KEY: "deployment-secret",
        AGENT_TOOL_TOKEN: "agent-secret",
      },
    });
    profiles.push(profile);

    expect((await stat(profile.codexHome)).mode & 0o777).toBe(0o700);
    expect(profile.environment).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      LANG: "C.UTF-8",
      CODEX_HOME: profile.codexHome,
    });
    expect(profile.codexHome).not.toBe("/host/.codex");
    expect(profile.environment.CODEX_AUTH_PATH).toBeUndefined();
    expect(profile.environment.HOME).toBeUndefined();
    expect(profile.environment.OPENAI_API_KEY).toBeUndefined();
    expect(profile.environment.AGENT_TOOL_TOKEN).toBeUndefined();
  });

  it("exposes only its own home to a spawned fixture and removes it idempotently", async () => {
    const profile = await createCodexRuntimeProfile({
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: "/host/.codex",
        CODEX_AUTH_PATH: "/host/.codex/auth.json",
      },
    });
    profiles.push(profile);

    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({home:process.env.CODEX_HOME,auth:process.env.CODEX_AUTH_PATH}))",
      ],
      { env: profile.environment, stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ home: profile.codexHome });

    await profile.dispose();
    await profile.dispose();
    await expect(access(profile.codexHome)).rejects.toThrow();
  });

  it("generates a fixed OpenRouter Responses provider without serializing its key", async () => {
    const profile = await createOpenRouterRuntimeProfile({
      apiKey: "fixture-openrouter-secret",
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: "/host/.codex",
        CODEX_CONFIG: 'model_provider = "attacker"',
        OPENAI_BASE_URL: "https://attacker.invalid/v1",
        INJECT_ME: "host-secret",
      },
      // Runtime input may contain extra JSON fields, but none may alter the provider contract.
      baseUrl: "https://attacker.invalid/v1",
      wireApi: "chat",
      config: 'model_provider = "attacker"',
      additionalEnvironmentKeys: ["INJECT_ME"],
    } as never);
    profiles.push(profile);

    const config = await readFile(
      join(profile.codexHome, "config.toml"),
      "utf8",
    );
    expect(config).toContain(`base_url = "${OPENROUTER_BASE_URL}"`);
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain(
      `env_key = "${OPENROUTER_API_KEY_ENVIRONMENT_KEY}"`,
    );
    expect(config).toContain(
      `exclude = ["${OPENROUTER_API_KEY_ENVIRONMENT_KEY}"]`,
    );
    expect(config).not.toContain("attacker.invalid");
    expect(config).not.toContain("fixture-openrouter-secret");
    expect(profile.environment[OPENROUTER_API_KEY_ENVIRONMENT_KEY]).toBe(
      "fixture-openrouter-secret",
    );
    expect(profile.environment.CODEX_CONFIG).toBeUndefined();
    expect(profile.environment.OPENAI_BASE_URL).toBeUndefined();
    expect(profile.environment.INJECT_ME).toBeUndefined();
    expect(
      (await stat(join(profile.codexHome, "config.toml"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("lets the installed provider read the key while Codex strips it from a fixture command", async () => {
    const profile = await createOpenRouterRuntimeProfile({
      apiKey: "fixture-openrouter-secret",
      environment: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    });
    profiles.push(profile);

    expect(profile.environment[OPENROUTER_API_KEY_ENVIRONMENT_KEY]).toBe(
      "fixture-openrouter-secret",
    );
    const result = await runCodexCommandProbe(profile);
    expect(result.initialized).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("missing");
  }, 15_000);
});

async function runCodexCommandProbe(profile: CodexRuntimeProfile): Promise<{
  initialized: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn("codex", ["app-server", "--strict-config", "--stdio"], {
    env: profile.environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`;
  });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
    }
  >();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: unknown;
    };
    if (message.id === undefined) return;
    const pending = responses.get(message.id);
    if (!pending) return;
    responses.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result ?? {});
  });

  const request = (
    id: number,
    method: string,
    params: Record<string, unknown>,
  ) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      responses.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  try {
    await withProbeTimeout(
      request(1, "initialize", {
        clientInfo: { name: "openbot-profile-probe", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      }),
      "initialize",
      () => stderr,
    );
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
    const result = await withProbeTimeout(
      request(2, "command/exec", {
        command: [
          process.execPath,
          "-e",
          `console.log(process.env.${OPENROUTER_API_KEY_ENVIRONMENT_KEY} ?? "missing")`,
        ],
        cwd: tmpdir(),
        sandboxPolicy: { type: "dangerFullAccess" },
        timeoutMs: 5_000,
      }),
      "command/exec",
      () => stderr,
    );
    return {
      initialized: true,
      exitCode: Number(result.exitCode),
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } finally {
    child.kill("SIGTERM");
    lines.close();
    for (const pending of responses.values()) {
      pending.reject(new Error(`Codex probe stopped: ${stderr}`));
    }
  }
}

async function withProbeTimeout<T>(
  promise: Promise<T>,
  phase: string,
  stderr: () => string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`Codex ${phase} probe timed out: ${stderr()}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
