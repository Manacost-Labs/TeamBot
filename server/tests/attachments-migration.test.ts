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
    const entry = journal.entries.find((candidate) => candidate.idx === 24);
    const previous = journal.entries.find((candidate) => candidate.idx === 23);

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

  test("adds the ordered 0025 leased blob inventory and backfills before the attachment FK", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: JournalEntry[] };
    const entry = journal.entries.find((candidate) => candidate.idx === 25);
    const previous = journal.entries.find((candidate) => candidate.idx === 24);

    expect(entry?.idx).toBe(25);
    expect(entry?.tag).toMatch(/^0025_/);
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
    if (!entry) throw new Error("Expected blob inventory migration");

    const migration = await readFile(
      new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim();

    expect(normalized).toContain(
      `CREATE TYPE "public"."attachment_blob_state" AS ENUM('uploading', 'publishing', 'live', 'deleting')`,
    );
    expect(normalized).toContain(`CREATE TABLE "attachment_blobs"`);
    expect(normalized).toContain(`"storage_key" varchar(1024) PRIMARY KEY`);
    expect(normalized).toContain(`"state" "attachment_blob_state" NOT NULL`);
    expect(normalized).toContain(`"lease_token" uuid`);
    expect(normalized).toContain(`"lease_expires_at" timestamp with time zone`);
    expect(normalized).toContain(`"attempts" integer DEFAULT 0 NOT NULL`);
    expect(normalized).toContain(
      `"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL`,
    );
    expect(normalized).toContain(
      `INSERT INTO "attachment_blobs" ("storage_key", "state", "owner_user_id", "channel_id", "created_at", "updated_at") SELECT "storage_key", 'live', "owner_user_id", "channel_id", "created_at", "created_at" FROM "attachments"`,
    );
    const backfill = normalized.indexOf(`INSERT INTO "attachment_blobs"`);
    const storageForeignKey = normalized.indexOf(
      `ADD CONSTRAINT "attachments_storage_key_attachment_blobs_storage_key_fk"`,
    );
    expect(backfill).toBeGreaterThan(-1);
    expect(storageForeignKey).toBeGreaterThan(backfill);
    expect(normalized).toContain(
      `FOREIGN KEY ("storage_key") REFERENCES "public"."attachment_blobs"("storage_key") ON DELETE no action`,
    );
    expect(normalized).toContain(`attachment_blobs_due_lease_idx`);
    expect(normalized).not.toContain("attachment_blob_deletions");
  });
});
