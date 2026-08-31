import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

type JournalEntry = { idx: number; tag: string; when: number };

describe("Google append operation migration", () => {
  test("is migration 0028 and stores no append payload", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: JournalEntry[] };
    const entry = journal.entries.find((candidate) => candidate.idx === 28);
    const previous = journal.entries.find((candidate) => candidate.idx === 27);

    expect(entry?.idx).toBe(28);
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    if (!entry) throw new Error("Expected migration 0028");

    const migration = await readFile(
      new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim();
    expect(normalized).toContain(
      `CREATE TYPE "public"."google_append_operation_state" AS ENUM('prepared', 'dispatching', 'succeeded', 'ambiguous', 'not_applied')`,
    );
    expect(normalized).toContain(`CREATE TABLE "google_append_operations"`);
    expect(normalized).toContain(`google_append_operations_request_key`);
    expect(normalized).toContain(`google_append_operations_state_check`);
    expect(normalized).not.toMatch(
      /"(args|payload|rows|text|content|result)"/i,
    );

    const snapshot = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/0028_snapshot.json", import.meta.url),
        "utf8",
      ),
    ) as { tables?: Record<string, unknown>; enums?: Record<string, unknown> };
    expect(snapshot.tables?.["public.google_append_operations"]).toBeDefined();
    expect(
      snapshot.enums?.["public.google_append_operation_state"],
    ).toBeDefined();
  });
});
