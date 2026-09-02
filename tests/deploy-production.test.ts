import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

type DeployTestOptions = {
  agentRunning?: boolean;
  expectedExitCode?: number;
  failInspect?: boolean;
  failPs?: boolean;
  failReplacement?: boolean;
  failResume?: boolean;
  failWorkerRestore?: boolean;
  agentDisappearsAfterDrain?: boolean;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runDeploy(
  options: DeployTestOptions = {},
  ...services: string[]
) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-deploy-test-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "docker.log");
  const docker = join(directory, "docker");

  await writeFile(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
for name in TELEGRAM_LOGIN_BOT_TOKEN TELEGRAM_OIDC_CLIENT_ID TELEGRAM_OIDC_CLIENT_SECRET TELEGRAM_ALLOWED_USER_IDS TELEGRAM_OWNER_USER_IDS OPENROUTER_MODEL; do
  if printenv "$name" >/dev/null 2>&1; then printf 'ENV_PRESENT %s\\n' "$name" >> "$DEPLOY_TEST_LOG"; fi
done
if [ "$1" = "info" ]; then exit 0; fi
is_ps=false
for arg in "$@"; do
  if [ "$arg" = "ps" ]; then is_ps=true; fi
done
if [ "$1" = "compose" ] && [ "$is_ps" = "true" ]; then
  if [ "\${DEPLOY_TEST_FAIL_PS:-0}" = "1" ]; then exit 17; fi
  if [ "\${DEPLOY_TEST_AGENT_RUNNING:-0}" = "1" ]; then
    ps_count_file="\${DEPLOY_TEST_LOG}.ps-count"
    ps_count=0
    if [ -f "$ps_count_file" ]; then ps_count=$(sed -n '1p' "$ps_count_file"); fi
    ps_count=$((ps_count + 1))
    printf '%s\\n' "$ps_count" > "$ps_count_file"
    if [ "\${DEPLOY_TEST_AGENT_DISAPPEARS_AFTER_DRAIN:-0}" != "1" ] || [ "$ps_count" -eq 1 ]; then
      printf 'agent-container\\n'
    fi
  fi
  exit 0
fi
if [ "$1" = "inspect" ] && [ "\${DEPLOY_TEST_FAIL_INSPECT:-0}" = "1" ]; then exit 18; fi
is_up=false
has_routine_worker=false
for arg in "$@"; do
  if [ "$arg" = "up" ]; then is_up=true; fi
  if [ "$arg" = "routine-worker" ]; then has_routine_worker=true; fi
done
if [ "$1" = "compose" ] && [ "$is_up" = "true" ]; then
  if [ "\${DEPLOY_TEST_FAIL_REPLACEMENT:-0}" = "1" ] && [ "$has_routine_worker" = "false" ]; then
    exit 20
  fi
  if [ "\${DEPLOY_TEST_FAIL_WORKER_RESTORE:-0}" = "1" ] && [ "$has_routine_worker" = "true" ]; then
    exit 21
  fi
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *"/admin/resume"*)
      if [ "\${DEPLOY_TEST_FAIL_RESUME:-0}" = "1" ]; then exit 19; fi
      ;;
    *"/health"*) printf '0 0\\n';;
  esac
fi
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
        TELEGRAM_OIDC_CLIENT_ID: "123456789",
        TELEGRAM_OIDC_CLIENT_SECRET: "test-test-test-test-test-test-test-test",
        TELEGRAM_ALLOWED_USER_IDS: "123456789,987654321",
        TELEGRAM_OWNER_USER_IDS: "123456789",
        OPENROUTER_MODEL: "openai/synthetic-test-model",
        DEPLOY_TEST_AGENT_RUNNING: options.agentRunning ? "1" : "0",
        DEPLOY_TEST_FAIL_INSPECT: options.failInspect ? "1" : "0",
        DEPLOY_TEST_FAIL_PS: options.failPs ? "1" : "0",
        DEPLOY_TEST_FAIL_REPLACEMENT: options.failReplacement ? "1" : "0",
        DEPLOY_TEST_FAIL_RESUME: options.failResume ? "1" : "0",
        DEPLOY_TEST_FAIL_WORKER_RESTORE: options.failWorkerRestore ? "1" : "0",
        DEPLOY_TEST_AGENT_DISAPPEARS_AFTER_DRAIN:
          options.agentDisappearsAfterDrain ? "1" : "0",
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
  const expectedExitCode = options.expectedExitCode ?? 0;
  expect(exitCode).toBe(expectedExitCode);
  if (expectedExitCode === 0) {
    expect({ stdout, stderr }).toEqual({ stdout: "", stderr: "" });
  }
  return { exitCode, log: await readFile(log, "utf8"), stderr, stdout };
}

test("a targeted OpenBot deployment also replaces its network-sharing routine worker", async () => {
  const { log } = await runDeploy({}, "openbot");

  expect(log).toContain("build openbot\n");
  expect(log).toContain("stop --timeout 30 routine-worker\n");
  expect(log).toContain("up -d --no-build --wait openbot routine-worker\n");
});

test("an unrelated targeted deployment stays targeted", async () => {
  const { log } = await runDeploy({}, "agent-codex");

  expect(log).toContain("build agent-codex\n");
  expect(log).toContain("up -d --no-build --wait agent-codex\n");
  expect(log).not.toContain("routine-worker");
});

test("a full deployment stops the network-sharing worker before replacement", async () => {
  const { log } = await runDeploy();

  expect(log).toContain("build\n");
  expect(log).toContain("stop --timeout 30 routine-worker\n");
  expect(log).toContain("up -d --no-build --wait\n");
});

test("uses the base and protected environment files only as Compose interpolation sources", async () => {
  const { log } = await runDeploy({}, "agent-codex");
  const repository = join(import.meta.dir, "..");

  expect(log).toContain(
    `compose --env-file ${join(repository, ".env")} --env-file ${join(repository, ".env.manacostteam-auth")} -f ${join(repository, "docker-compose.production.yml")} config --quiet\n`,
  );
  expect(log).not.toContain("TELEGRAM_LOGIN_BOT_TOKEN=");
  expect(log).not.toContain("TELEGRAM_OIDC_CLIENT_ID=");
  expect(log).not.toContain("TELEGRAM_OIDC_CLIENT_SECRET=");
  expect(log).not.toContain("TELEGRAM_ALLOWED_USER_IDS=");
  expect(log).not.toContain("TELEGRAM_OWNER_USER_IDS=");
  expect(log).not.toContain("OPENROUTER_MODEL=");
  expect(log).not.toContain("ENV_PRESENT");
});

test("fails closed before build when Compose cannot inspect the managed runtime", async () => {
  const result = await runDeploy(
    { expectedExitCode: 1, failPs: true },
    "agent-codex",
  );

  expect(result.stderr).toContain(
    "Deployment cancelled: could not inspect the managed runtime before draining.",
  );
  expect(result.log).not.toContain("build agent-codex");
  expect(result.log).not.toContain("up -d --no-build --wait agent-codex");
});

test("fails closed before build when the running managed runtime cannot be inspected", async () => {
  const result = await runDeploy(
    { agentRunning: true, expectedExitCode: 1, failInspect: true },
    "agent-codex",
  );

  expect(result.stderr).toContain(
    "Deployment cancelled: managed runtime container could not be inspected before draining.",
  );
  expect(result.log).not.toContain("build agent-codex");
});

test("returns a failure when the drained managed runtime cannot be resumed", async () => {
  const result = await runDeploy(
    { agentRunning: true, expectedExitCode: 1, failResume: true },
    "agent-codex",
  );

  expect(result.stderr).toContain(
    "Deployment failed: managed runtime admission could not resume.",
  );
  expect(
    (result.log.match(/\/admin\/resume/g) ?? []).length,
  ).toBeGreaterThanOrEqual(2);
});

test("drains and resumes an already running managed runtime on a successful replacement", async () => {
  const result = await runDeploy({ agentRunning: true }, "agent-codex");

  expect(result.stderr).toBe("");
  expect(result.log).toContain("/admin/drain");
  expect(result.log).toContain("/admin/resume");
});

test("returns a failure when the drained managed runtime disappears", async () => {
  const result = await runDeploy(
    {
      agentDisappearsAfterDrain: true,
      agentRunning: true,
      expectedExitCode: 1,
    },
    "agent-codex",
  );

  expect(result.stderr).toContain(
    "Deployment failed: managed runtime disappeared while the deployment was draining.",
  );
  expect(result.log).not.toContain("/admin/resume");
});

test("returns a failure when cleanup cannot restore routine-worker", async () => {
  const result = await runDeploy({
    agentRunning: true,
    expectedExitCode: 1,
    failReplacement: true,
    failWorkerRestore: true,
  });

  expect(result.stderr).toContain(
    "Deployment failed: routine-worker could not be restored during cleanup.",
  );
  expect(result.log).toContain("up -d --no-build routine-worker");
});
