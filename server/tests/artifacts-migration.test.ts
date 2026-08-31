import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

type JournalEntry = { idx: number; tag: string; when: number };

describe("artifact export migration", () => {
  test("is ordered after attachment storage and contains no artifact payload", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: JournalEntry[] };
    const entry = journal.entries.at(-1);
    const previous = journal.entries.at(-2);

    expect(entry?.idx).toBe(26);
    expect(entry?.tag).toBe("0026_artifact_exports");
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    expect(entry?.when).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1_000);
    if (!entry) throw new Error("Expected artifact export migration");

    const migration = await readFile(
      new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim();
    expect(normalized).toContain(
      `CREATE TYPE "public"."artifact_export_state" AS ENUM('creating', 'ready', 'failed')`,
    );
    expect(normalized).toContain(`CREATE TABLE "artifact_exports"`);
    expect(normalized).toContain(`artifact_exports_request_key`);
    expect(normalized).toContain(`artifact_exports_recovery_idx`);
    expect(normalized).toContain(`artifact_exports_lease_state_check`);
    expect(normalized).not.toMatch(
      /"(content|html|markdown|base64|bytes|path)"/i,
    );

    const snapshot = JSON.parse(
      await readFile(
        new URL(
          `../drizzle/meta/${entry.idx.toString().padStart(4, "0")}_snapshot.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { tables?: Record<string, unknown>; enums?: Record<string, unknown> };
    expect(snapshot.tables?.["public.artifact_exports"]).toBeDefined();
    expect(snapshot.enums?.["public.artifact_export_state"]).toBeDefined();
  });
});
