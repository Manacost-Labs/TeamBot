import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexRuntimeProfile,
  createCodexRuntimeProfile,
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
});
