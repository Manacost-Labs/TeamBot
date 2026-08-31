/** Durable idempotency for model-created conversation artifacts. */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { channelMemberships } from "./core";

export const artifactExportState = pgEnum("artifact_export_state", [
  "creating",
  "ready",
  "failed",
]);

/**
 * One logical artifact request, independent of the replica that performs it.
 *
 * The attachment remains the canonical file record. This row only makes a repeated tool call in
 * the same run converge on that file instead of rendering and storing a second copy. A lease lets a
 * later retry recover work left by a dead replica without holding a database transaction while
 * Chromium renders.
 */
export const artifactExports = pgTable(
  "artifact_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id").notNull(),
    channelId: text("channel_id").notNull(),
    botId: text("bot_id").notNull(),
    runId: text("run_id").notNull(),
    requestFingerprint: char("request_fingerprint", { length: 64 }).notNull(),
    state: artifactExportState("state").notNull(),
    /** Opaque public attachment UUID. Deliberately not an FK: a person may delete the file later. */
    attachmentId: uuid("attachment_id"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "artifact_exports_channel_membership_fk",
      columns: [table.channelId, table.ownerUserId],
      foreignColumns: [channelMemberships.channelId, channelMemberships.userId],
    }),
    uniqueIndex("artifact_exports_request_key").on(
      table.ownerUserId,
      table.channelId,
      table.botId,
      table.runId,
      table.requestFingerprint,
    ),
    index("artifact_exports_recovery_idx").on(
      table.state,
      table.leaseExpiresAt,
      table.updatedAt,
    ),
    check(
      "artifact_exports_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check("artifact_exports_attempts_check", sql`${table.attempts} >= 1`),
    check(
      "artifact_exports_identity_length_check",
      sql`char_length(${table.ownerUserId}) BETWEEN 1 AND 255
        AND char_length(${table.channelId}) BETWEEN 1 AND 255
        AND char_length(${table.botId}) BETWEEN 1 AND 255
        AND char_length(${table.runId}) BETWEEN 1 AND 4096`,
    ),
    check(
      "artifact_exports_lease_state_check",
      sql`(
        ${table.state} = 'creating'
        AND ${table.leaseToken} IS NOT NULL
        AND ${table.leaseExpiresAt} IS NOT NULL
        AND ${table.attachmentId} IS NULL
      ) OR (
        ${table.state} = 'ready'
        AND ${table.leaseToken} IS NULL
        AND ${table.leaseExpiresAt} IS NULL
        AND ${table.attachmentId} IS NOT NULL
      ) OR (
        ${table.state} = 'failed'
        AND ${table.leaseToken} IS NULL
        AND ${table.leaseExpiresAt} IS NULL
        AND ${table.attachmentId} IS NULL
      )`,
    ),
  ],
);
