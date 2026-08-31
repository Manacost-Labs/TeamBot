import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("confirmed Google document edit migration", () => {
  test("is migration 0030 with encrypted payload and no plaintext columns", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((candidate) => candidate.idx === 30);
    expect(entry?.tag).toBe("0030_confirmed_google_document_edits");
    if (!entry) throw new Error("Expected migration 0030");
    const migration = await readFile(
      new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "google_document_edits"');
    expect(migration).toContain('"encrypted_payload" text');
    expect(migration).not.toMatch(
      /"(source_text|candidate_text|expected_text|replacement_text)"/,
    );
    expect(migration).toContain("google_document_edits_payload_state_check");
  });
});
