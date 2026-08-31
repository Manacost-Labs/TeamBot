import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

export const googleDocumentEditState = pgEnum("google_document_edit_state", [
  "pending",
  "dispatching",
  "succeeded",
  "not_applied",
  "ambiguous",
  "expired",
  "declined",
  "superseded",
]);

/**
 * A human-reviewable Google Docs edit, kept outside the transcript and consumed at most once.
 *
 * The only content-bearing field is encryptedPayload. Everything else is safe routing, bounded
 * cardinality or a digest. Terminal transitions clear the ciphertext so a completed edit does not
 * become a second long-lived copy of somebody's document.
 */
export const googleDocumentEdits = pgTable(
  "google_document_edits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sourceRunId: text("source_run_id").notNull(),
    threadId: text("thread_id").notNull(),
    documentId: text("document_id").notNull(),
    tabId: text("tab_id").notNull(),
    proposalDigest: char("proposal_digest", { length: 64 }).notNull(),
    encryptedPayload: text("encrypted_payload"),
    state: googleDocumentEditState("state").notNull().default("pending"),
    editCount: integer("edit_count").notNull(),
    removedCharacters: integer("removed_characters").notNull(),
    insertedCharacters: integer("inserted_characters").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    dispatchStartedAt: timestamp("dispatch_started_at", {
      withTimezone: true,
    }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("google_document_edits_actor_created_idx").on(
      table.actorId,
      table.createdAt,
    ),
    index("google_document_edits_state_expiry_idx").on(
      table.state,
      table.expiresAt,
    ),
    check(
      "google_document_edits_counts_check",
      sql`${table.editCount} between 1 and 30 and ${table.removedCharacters} >= 1 and ${table.insertedCharacters} >= 1`,
    ),
    check(
      "google_document_edits_payload_state_check",
      sql`(${table.state} in ('pending', 'dispatching') and ${table.encryptedPayload} is not null) or (${table.state} not in ('pending', 'dispatching') and ${table.encryptedPayload} is null)`,
    ),
  ],
);
