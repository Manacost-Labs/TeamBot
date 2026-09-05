import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("CI installs the production Codex version before running its security probe", async () => {
  const root = join(import.meta.dir, "..");
  const dockerfile = await readFile(
    join(root, "agent-codex/Dockerfile"),
    "utf8",
  );
  const workflow = await readFile(
    join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  const version = dockerfile.match(
    /bun add @openai\/codex@(\d+\.\d+\.\d+)/,
  )?.[1];
  expect(version).toBeDefined();
  const testJob =
    workflow.split("\n  test:\n")[1]?.split("\n  build:\n")[0] ?? "";
  const install = testJob.indexOf(`bun add --global @openai/codex@${version}`);
  expect(install).toBeGreaterThanOrEqual(0);
  expect(testJob.indexOf("codex --version")).toBeGreaterThan(install);
  expect(testJob.indexOf("make verify-tests")).toBeGreaterThan(install);
});

test.each(["pdf-extractor", "artifact-renderer"])(
  "CI installs the isolated %s dependencies before the canonical test gate",
  async (service) => {
    const workflow = await readFile(
      join(import.meta.dir, "..", ".github/workflows/ci.yml"),
      "utf8",
    );
    const testJob =
      workflow.split("\n  test:\n")[1]?.split("\n  build:\n")[0] ?? "";
    const install = testJob.indexOf(
      `- run: npm ci\n        working-directory: ${service}`,
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(testJob.indexOf("make verify-tests")).toBeGreaterThan(install);
  },
);
