import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runDeploy(...services: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-deploy-test-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "docker.log");
  const docker = join(directory, "docker");

  await writeFile(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
for name in TELEGRAM_LOGIN_BOT_TOKEN TELEGRAM_ALLOWED_USER_IDS TELEGRAM_OWNER_USER_IDS OPENROUTER_MODEL; do
  if printenv "$name" >/dev/null 2>&1; then printf 'ENV_PRESENT %s\\n' "$name" >> "$DEPLOY_TEST_LOG"; fi
done
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "compose" ] && [ "$5" = "ps" ]; then exit 0; fi
exit 0
`,
  );
  await chmod(docker, 0o755);

  const process = Bun.spawn(
    [
      "bash",
      join(import.meta.dir, "..", "scripts", "deploy-production.sh"),
      ...services,
    ],
    {
      env: {
        ...Bun.env,
        PATH: `${directory}:${Bun.env.PATH ?? ""}`,
        DEPLOY_TEST_LOG: log,
        ARTIFACT_RENDERER_TOKEN: "test-renderer-token",
        TELEGRAM_LOGIN_BOT_TOKEN: "123456:synthetic-test-token",
        TELEGRAM_ALLOWED_USER_IDS: "123456789,987654321",
        TELEGRAM_OWNER_USER_IDS: "123456789",
        OPENROUTER_MODEL: "openai/synthetic-test-model",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  return readFile(log, "utf8");
}

test("a targeted OpenBot deployment also replaces its network-sharing routine worker", async () => {
  const log = await runDeploy("openbot");

  expect(log).toContain("build openbot\n");
  expect(log).toContain("stop --timeout 30 routine-worker\n");
  expect(log).toContain("up -d --no-build --wait openbot routine-worker\n");
});

test("an unrelated targeted deployment stays targeted", async () => {
  const log = await runDeploy("agent-codex");

  expect(log).toContain("build agent-codex\n");
  expect(log).toContain("up -d --no-build --wait agent-codex\n");
  expect(log).not.toContain("routine-worker");
});

test("a full deployment stops the network-sharing worker before replacement", async () => {
  const log = await runDeploy();

  expect(log).toContain("build\n");
  expect(log).toContain("stop --timeout 30 routine-worker\n");
  expect(log).toContain("up -d --no-build --wait\n");
});

test("uses the base and protected environment files only as Compose interpolation sources", async () => {
  const log = await runDeploy("agent-codex");
  const repository = join(import.meta.dir, "..");

  expect(log).toContain(
    `compose --env-file ${join(repository, ".env")} --env-file ${join(repository, ".env.manacostteam-auth")} -f ${join(repository, "docker-compose.production.yml")} config --quiet\n`,
  );
  expect(log).not.toContain("TELEGRAM_LOGIN_BOT_TOKEN=");
  expect(log).not.toContain("TELEGRAM_ALLOWED_USER_IDS=");
  expect(log).not.toContain("TELEGRAM_OWNER_USER_IDS=");
  expect(log).not.toContain("OPENROUTER_MODEL=");
  expect(log).not.toContain("ENV_PRESENT");
});
