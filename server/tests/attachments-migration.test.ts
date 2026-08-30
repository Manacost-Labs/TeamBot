import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

type JournalEntry = { idx: number; tag: string; when: number };

describe("attachment metadata migration", () => {
  test("is the ordered 0024 journal entry and contains no inline payload column", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: JournalEntry[] };
    const entry = journal.entries.at(-1);
    const previous = journal.entries.at(-2);

    expect(entry?.idx).toBe(24);
    expect(entry?.tag).toMatch(/^0024_/);
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    expect(entry?.when).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1_000);
    if (!entry) throw new Error("Expected attachment migration journal entry");

    const migration = await readFile(
      new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim();

    expect(normalized).toContain(
      `CREATE TYPE "public"."attachment_source" AS ENUM('user_upload', 'agent_generated', 'tool_generated', 'google_export')`,
    );
    expect(normalized).toContain(`CREATE TABLE "attachments"`);
    expect(normalized).toContain(`"size" bigint NOT NULL`);
    expect(normalized).toContain(`"sha256" char(64) NOT NULL`);
    expect(normalized).toContain(
      `FOREIGN KEY ("channel_id","owner_user_id") REFERENCES "public"."channel_memberships"("channel_id","user_id") ON DELETE no action`,
    );
    expect(normalized).not.toContain(
      `FOREIGN KEY ("channel_id","owner_user_id") REFERENCES "public"."channel_memberships"("channel_id","user_id") ON DELETE cascade`,
    );
    expect(normalized).toContain(`CHECK ("attachments"."size" > 0)`);
    expect(normalized).toContain(
      `CHECK ("attachments"."sha256" ~ '^[0-9a-f]{64}$')`,
    );
    expect(normalized).toContain(
      `CREATE INDEX "attachments_owner_channel_created_idx" ON "attachments" USING btree ("owner_user_id","channel_id","created_at","id")`,
    );
    expect(normalized).toContain(
      `CREATE INDEX "attachments_owner_channel_message_idx" ON "attachments" USING btree ("owner_user_id","channel_id","message_id")`,
    );
    expect(normalized).not.toMatch(/\b(blob|base64|bytea)\b/i);
  });
});
