import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
const makefile = join(import.meta.dir, "..", "Makefile");
const testDatabase = "postgres://test@127.0.0.1:15432/openbot_test";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function verify(target: string, database = testDatabase, fail = "") {
  const directory = await mkdtemp(join(tmpdir(), "openbot-verify-test-"));
  directories.push(directory);
  const log = join(directory, "calls.log");
  const bun = join(directory, "bun");
  await writeFile(
    bun,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$VERIFY_LOG"
if [ "$*" = "run test:ci" ]; then
  [ "$DATABASE_URL" = "$EXPECTED_TEST_DATABASE" ] || exit 42
fi
[ "$*" != "$VERIFY_FAIL" ] || exit 23
`,
  );
  await chmod(bun, 0o755);
  const child = Bun.spawn(
    ["make", "--no-print-directory", "-f", makefile, target],
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        // An inherited database must never silently authorize the integration test run.
        DATABASE_URL: "postgres://unexpected@127.0.0.1:5432/do_not_use",
        TEST_DATABASE_URL: database,
        EXPECTED_TEST_DATABASE: testDatabase,
        VERIFY_LOG: log,
        VERIFY_FAIL: fail,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const calls = await readFile(log, "utf8").catch(() => "");
  return { code, calls, output: stdout + stderr };
}

test.each(["check", "verify"])(
  "%s runs the existing complete project gate",
  async (target) => {
    const result = await verify(target);
    expect(result.code).toBe(0);
    expect(result.calls.trim().split("\n")).toEqual([
      "run format:check",
      "run lint",
      "run typecheck",
      "run test:ci",
      "run build",
    ]);
  },
);

test("a failed static check stops before tests and build", async () => {
  const result = await verify("check", testDatabase, "run lint");
  expect(result.code).not.toBe(0);
  expect(result.calls.trim().split("\n")).toEqual([
    "run format:check",
    "run lint",
  ]);
});

test("integration requires an explicit test database even if DATABASE_URL is inherited", async () => {
  const result = await verify("verify-tests", "");
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("TEST_DATABASE_URL");
  expect(result.calls).toBe("");
});

test.each([
  ["verify-static", ["run format:check", "run lint", "run typecheck"]],
  ["verify-tests", ["run test:ci"]],
  ["verify-build", ["run build"]],
] as const)("%s runs only its CI phase", async (target, calls) => {
  const result = await verify(target);
  expect(result.code).toBe(0);
  expect(result.calls.trim().split("\n")).toEqual(calls);
});
