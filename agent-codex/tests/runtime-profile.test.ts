import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import {
  createOpenRouterCredentialBroker,
  type OpenRouterCredentialBroker,
} from "../src/openrouter-credential-broker";
import {
  type CodexRuntimeProfile,
  createCodexRuntimeProfile,
  createOpenRouterRuntimeProfile,
  OPENROUTER_API_KEY_ENVIRONMENT_KEY,
} from "../src/runtime-profile";

const profiles: CodexRuntimeProfile[] = [];
const brokers: OpenRouterCredentialBroker[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(profiles.splice(0).map((profile) => profile.dispose()));
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
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

  it("refuses a symlinked or broadly readable shared profile root", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "openbot-root-test-"));
    temporaryRoots.push(fixtureRoot);
    const target = join(fixtureRoot, "target");
    const linked = join(fixtureRoot, "linked");
    const broad = join(fixtureRoot, "broad");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    await mkdir(broad, { mode: 0o700 });
    await chmod(broad, 0o755);

    await expect(
      createCodexRuntimeProfile({ parentDirectory: linked }),
    ).rejects.toThrow("Codex profile root is unavailable.");
    await expect(
      createCodexRuntimeProfile({ parentDirectory: broad }),
    ).rejects.toThrow("Codex profile root is unavailable.");
  });

  it("generates a fixed OpenRouter Responses provider without serializing its key", async () => {
    const broker = await fixtureBroker("fixture-openrouter-secret");
    const profile = await createOpenRouterRuntimeProfile({
      broker,
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: "/host/.codex",
        CODEX_CONFIG: 'model_provider = "attacker"',
        OPENAI_BASE_URL: "https://attacker.invalid/v1",
        INJECT_ME: "host-secret",
        RESEARCH_SOURCES_URL: "http://research-sources:8777",
        RESEARCH_SOURCE_GATEWAY_TOKEN: "research-gateway-secret",
      },
      // Runtime input may contain extra JSON fields, but none may alter the provider contract.
      baseUrl: "https://attacker.invalid/v1",
      wireApi: "chat",
      config: 'model_provider = "attacker"',
      additionalEnvironmentKeys: [
        "INJECT_ME",
        "RESEARCH_SOURCES_URL",
        "RESEARCH_SOURCE_GATEWAY_TOKEN",
      ],
    } as never);
    profiles.push(profile);

    const config = await readFile(
      join(profile.codexHome, "config.toml"),
      "utf8",
    );
    expect(
      config.indexOf('model_provider = "manacost_openrouter"'),
    ).toBeLessThan(config.indexOf("[history]"));
    expect(config).toContain(`base_url = "${broker.baseUrl}"`);
    expect(config).toContain('default_permissions = "openbot-agent"');
    expect(config).toContain("[features]");
    expect(config).toContain("apps = false");
    expect(config).toContain("browser_use = false");
    expect(config).toContain("computer_use = false");
    expect(config).toContain("multi_agent = false");
    expect(config).toContain("plugins = false");
    expect(config).not.toContain("in_app_local_automation");
    expect(config).not.toContain("skill_search");
    expect(config).toContain("[permissions.research-agent]");
    expect(config).toContain('wire_api = "responses"');
    expect(config).not.toContain("env_key =");
    expect(config).not.toMatch(/^auth\s*=/m);
    expect(config).not.toContain("openrouter.ai");
    expect(config).toContain(
      `${JSON.stringify(dirname(profile.codexHome))} = "deny"`,
    );
    expect(config).toContain(
      `exclude = ["${OPENROUTER_API_KEY_ENVIRONMENT_KEY}"]`,
    );
    expect(config).not.toContain("attacker.invalid");
    expect(config).not.toContain("fixture-openrouter-secret");
    expect(
      profile.environment[OPENROUTER_API_KEY_ENVIRONMENT_KEY],
    ).toBeUndefined();
    expect(profile.environment.CODEX_CONFIG).toBeUndefined();
    expect(profile.environment.OPENAI_BASE_URL).toBeUndefined();
    expect(profile.environment.INJECT_ME).toBeUndefined();
    expect(profile.environment.RESEARCH_SOURCES_URL).toBe(
      "http://research-sources:8777",
    );
    expect(profile.environment.RESEARCH_SOURCE_GATEWAY_TOKEN).toBe(
      "research-gateway-secret",
    );
    expect(
      (await stat(join(profile.codexHome, "config.toml"))).mode & 0o777,
    ).toBe(0o600);
    await expect(
      access(join(profile.codexHome, "openrouter-token")),
    ).rejects.toThrow();

    const environment = profile.environment;
    await profile.dispose();
    expect(environment[OPENROUTER_API_KEY_ENVIRONMENT_KEY]).toBeUndefined();
    await expect(access(profile.codexHome)).rejects.toThrow();
  });

  it("keeps the key out of the installed Codex command environment", async () => {
    const broker = await fixtureBroker("fixture-openrouter-secret");
    const profile = await createOpenRouterRuntimeProfile({
      broker,
      environment: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        RESEARCH_SOURCES_URL: "http://research-sources:8777",
        RESEARCH_SOURCE_GATEWAY_TOKEN: "research-gateway-secret",
      },
      additionalEnvironmentKeys: [
        "RESEARCH_SOURCES_URL",
        "RESEARCH_SOURCE_GATEWAY_TOKEN",
      ],
    });
    profiles.push(profile);

    expect(
      profile.environment[OPENROUTER_API_KEY_ENVIRONMENT_KEY],
    ).toBeUndefined();
    const result = await runCodexCommandProbe(profile);
    expect(result.initialized).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      openRouterKeyVisible: false,
      researchUrlVisible: true,
      researchTokenVisible: true,
    });
  }, 15_000);

  it("rejects a forged non-loopback broker before writing a provider profile", async () => {
    await expect(
      createOpenRouterRuntimeProfile({
        broker: { baseUrl: "https://attacker.invalid/v1" },
        environment: { PATH: process.env.PATH },
      }),
    ).rejects.toThrow("credential broker is unavailable");
  });
});

async function fixtureBroker(
  apiKey: string,
): Promise<OpenRouterCredentialBroker> {
  const broker = await createOpenRouterCredentialBroker({
    apiKey,
    fetch: async (input) => {
      const request = new Request(input);
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [
            {
              id: "openrouter/probe-model",
              object: "model",
              created: 1,
              owned_by: "fixture",
            },
          ],
        });
      }
      return new Response(null, { status: 500 });
    },
  });
  brokers.push(broker);
  return broker;
}

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
          `console.log(JSON.stringify({openRouterKeyVisible:process.env.${OPENROUTER_API_KEY_ENVIRONMENT_KEY}!==undefined,researchUrlVisible:process.env.RESEARCH_SOURCES_URL==="http://research-sources:8777",researchTokenVisible:process.env.RESEARCH_SOURCE_GATEWAY_TOKEN==="research-gateway-secret"}))`,
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
