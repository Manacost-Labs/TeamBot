import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("the overlap migration keeps skip as the backward-compatible default and adds firing identity", async () => {
  const sql = await readFile(
    new URL("../drizzle/0029_lazy_firestar.sql", import.meta.url),
    "utf8",
  );

  expect(sql).toContain(
    `routine_overlap_policy" AS ENUM('skip', 'queue_one', 'allow_overlap')`,
  );
  expect(sql).toContain(
    `"overlap_policy" "routine_overlap_policy" DEFAULT 'skip' NOT NULL`,
  );
  expect(sql).toContain(`ADD COLUMN "queued_firing_key" text`);
  expect(sql).toContain(
    `ADD COLUMN "queued_scheduled_for" timestamp with time zone`,
  );
  expect(sql).toContain(`ADD COLUMN "firing_key" text`);
  expect(sql).toContain(`CREATE UNIQUE INDEX "routine_runs_firing_key_unique"`);
});
