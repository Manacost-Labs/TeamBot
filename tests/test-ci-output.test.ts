import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the CI runner flushes a large failure report before preserving the failing exit code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-ci-output-"));
  try {
    const output = `${"failure details\n".repeat(60_000)}FINAL FAILURE SUMMARY\n`;
    const executable = join(directory, "bun");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(output)}, () => process.exit(7));\n`,
    );
    await chmod(executable, 0o755);
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "scripts", "test-ci.ts")],
      {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(7);
    expect(stderr.length).toBe(output.length);
    expect(stderr.endsWith("FINAL FAILURE SUMMARY\n")).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
