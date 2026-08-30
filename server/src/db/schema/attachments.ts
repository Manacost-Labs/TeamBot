import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { channelMemberships } from "./core";

export const attachmentSource = pgEnum("attachment_source", [
  "user_upload",
  "agent_generated",
  "tool_generated",
  "google_export",
]);

export const attachmentBlobState = pgEnum("attachment_blob_state", [
  "uploading",
  "publishing",
  "live",
  "deleting",
]);

/** Durable inventory and lease state for every temporary or published attachment blob. */
export const attachmentBlobs = pgTable(
  "attachment_blobs",
  {
    storageKey: varchar("storage_key", { length: 1024 }).primaryKey(),
    state: attachmentBlobState("state").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    channelId: text("channel_id").notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "attachment_blobs_channel_membership_fk",
      columns: [table.channelId, table.ownerUserId],
      foreignColumns: [channelMemberships.channelId, channelMemberships.userId],
    }),
    check("attachment_blobs_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "attachment_blobs_lease_pair_check",
      sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "attachment_blobs_storage_key_length_check",
      sql`char_length(${table.storageKey}) BETWEEN 1 AND 1024`,
    ),
    index("attachment_blobs_due_lease_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseExpiresAt,
      table.storageKey,
    ),
  ],
);

/**
 * Content-free attachment metadata.
 *
 * The bytes live behind `storageKey`; putting a blob/base64 copy here would bypass object-store
 * quotas, scanning and retention while making ordinary channel reads carry file payloads.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    name: varchar("name", { length: 512 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    storageKey: varchar("storage_key", { length: 1024 }).notNull().unique(),
    source: attachmentSource("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "attachments_channel_membership_fk",
      columns: [table.channelId, table.ownerUserId],
      foreignColumns: [channelMemberships.channelId, channelMemberships.userId],
    }),
    foreignKey({
      name: "attachments_storage_key_attachment_blobs_storage_key_fk",
      columns: [table.storageKey],
      foreignColumns: [attachmentBlobs.storageKey],
    }),
    check("attachments_size_check", sql`${table.size} > 0`),
    check("attachments_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "attachments_owner_user_id_length_check",
      sql`char_length(${table.ownerUserId}) BETWEEN 1 AND 255`,
    ),
    check(
      "attachments_channel_id_length_check",
      sql`char_length(${table.channelId}) BETWEEN 1 AND 255`,
    ),
    check(
      "attachments_message_id_length_check",
      sql`${table.messageId} IS NULL OR char_length(${table.messageId}) BETWEEN 1 AND 255`,
    ),
    check(
      "attachments_name_length_check",
      sql`char_length(${table.name}) BETWEEN 1 AND 512`,
    ),
    check(
      "attachments_mime_type_length_check",
      sql`char_length(${table.mimeType}) BETWEEN 1 AND 255`,
    ),
    check(
      "attachments_storage_key_length_check",
      sql`char_length(${table.storageKey}) BETWEEN 1 AND 1024`,
    ),
    index("attachments_owner_channel_created_idx").on(
      table.ownerUserId,
      table.channelId,
      table.createdAt,
      table.id,
    ),
    index("attachments_owner_channel_message_idx").on(
      table.ownerUserId,
      table.channelId,
      table.messageId,
    ),
  ],
);
