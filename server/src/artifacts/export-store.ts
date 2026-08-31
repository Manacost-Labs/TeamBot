import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { artifactExports } from "../db/schema";

const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 5 * 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ArtifactExportClaimContext = Readonly<{
  ownerUserId: string;
  channelId: string;
  botId: string;
  runId: string;
  fingerprint: string;
}>;

export type ArtifactExportClaim =
  | Readonly<{
      kind: "claimed";
      exportId: string;
      leaseToken: string;
      messageId: string;
    }>
  | Readonly<{
      kind: "ready";
      exportId: string;
      attachmentId: string;
    }>
  | Readonly<{ kind: "busy" }>;

export type ArtifactExportStore = Readonly<{
  claim(
    context: ArtifactExportClaimContext,
    leaseMs?: number,
  ): Promise<ArtifactExportClaim>;
  complete(
    exportId: string,
    leaseToken: string,
    attachmentId: string,
  ): Promise<boolean>;
  fail(exportId: string, leaseToken: string): Promise<boolean>;
  invalidateReady(exportId: string, attachmentId: string): Promise<boolean>;
}>;

type ArtifactExportRow = {
  id: string;
  state: "creating" | "ready" | "failed";
  attachmentId: string | null;
};

function boundedLeaseMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Artifact export lease must be a positive whole number");
  }
  return Math.min(value, MAX_LEASE_MS);
}

function validIdentity(value: string, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  );
}

function validContext(context: ArtifactExportClaimContext): boolean {
  return (
    validIdentity(context.ownerUserId, 255) &&
    validIdentity(context.channelId, 255) &&
    validIdentity(context.botId, 255) &&
    validIdentity(context.runId, 4_096) &&
    SHA256.test(context.fingerprint)
  );
}

export function artifactAttachmentMessageId(exportId: string): string {
  if (!UUID.test(exportId)) throw new Error("Invalid artifact export id");
  return `artifact:${exportId}`;
}

/**
 * Claim a logical artifact without keeping a transaction open while bytes are rendered or stored.
 *
 * A repeated request in the same run either receives the ready attachment, waits for the live
 * lease, or atomically takes over a failed/expired attempt. The request fingerprint contains no
 * secret and is the only content-derived value kept in PostgreSQL.
 */
export function createArtifactExportStore(
  database: Database,
): ArtifactExportStore {
  return Object.freeze({
    async claim(context, requestedLeaseMs) {
      if (!validContext(context)) {
        throw new Error("Invalid artifact export identity");
      }
      const leaseMs = boundedLeaseMs(requestedLeaseMs);
      const leaseToken = randomUUID();
      const claimed = await database.execute<ArtifactExportRow>(sql`
        insert into ${artifactExports} (
          "owner_user_id", "channel_id", "bot_id", "run_id",
          "request_fingerprint", "state", "lease_token", "lease_expires_at"
        ) values (
          ${context.ownerUserId}, ${context.channelId}, ${context.botId}, ${context.runId},
          ${context.fingerprint}, 'creating', ${leaseToken}::uuid,
          now() + (${leaseMs} * interval '1 millisecond')
        )
        on conflict (
          "owner_user_id", "channel_id", "bot_id", "run_id", "request_fingerprint"
        ) do update set
          "state" = 'creating',
          "attachment_id" = null,
          "lease_token" = ${leaseToken}::uuid,
          "lease_expires_at" = now() + (${leaseMs} * interval '1 millisecond'),
          "attempts" = ${artifactExports.attempts} + 1,
          "updated_at" = now()
        where ${artifactExports.state} = 'failed'
          or (
            ${artifactExports.state} = 'creating'
            and ${artifactExports.leaseExpiresAt} <= now()
          )
        returning
          "id",
          "state",
          "attachment_id" as "attachmentId"
      `);
      const owned = claimed[0];
      if (owned) {
        return {
          kind: "claimed",
          exportId: owned.id,
          leaseToken,
          messageId: artifactAttachmentMessageId(owned.id),
        };
      }

      const existing = await database.execute<ArtifactExportRow>(sql`
        select
          "id",
          "state",
          "attachment_id" as "attachmentId"
        from ${artifactExports}
        where "owner_user_id" = ${context.ownerUserId}
          and "channel_id" = ${context.channelId}
          and "bot_id" = ${context.botId}
          and "run_id" = ${context.runId}
          and "request_fingerprint" = ${context.fingerprint}
        limit 1
      `);
      const row = existing[0];
      return row?.state === "ready" && row.attachmentId
        ? {
            kind: "ready",
            exportId: row.id,
            attachmentId: row.attachmentId,
          }
        : { kind: "busy" };
    },

    async complete(exportId, leaseToken, attachmentId) {
      if (
        !UUID.test(exportId) ||
        !UUID.test(leaseToken) ||
        !UUID.test(attachmentId)
      ) {
        return false;
      }
      const [completed] = await database.execute<{ id: string }>(sql`
        update ${artifactExports}
        set
          "state" = 'ready',
          "attachment_id" = ${attachmentId}::uuid,
          "lease_token" = null,
          "lease_expires_at" = null,
          "updated_at" = now()
        where "id" = ${exportId}::uuid
          and "state" = 'creating'
          and "lease_token" = ${leaseToken}::uuid
          and "lease_expires_at" > now()
        returning "id"
      `);
      return completed !== undefined;
    },

    async fail(exportId, leaseToken) {
      if (!UUID.test(exportId) || !UUID.test(leaseToken)) return false;
      const [failed] = await database.execute<{ id: string }>(sql`
        update ${artifactExports}
        set
          "state" = 'failed',
          "attachment_id" = null,
          "lease_token" = null,
          "lease_expires_at" = null,
          "updated_at" = now()
        where "id" = ${exportId}::uuid
          and "state" = 'creating'
          and "lease_token" = ${leaseToken}::uuid
        returning "id"
      `);
      return failed !== undefined;
    },

    async invalidateReady(exportId, attachmentId) {
      if (!UUID.test(exportId) || !UUID.test(attachmentId)) return false;
      const [invalidated] = await database.execute<{ id: string }>(sql`
        update ${artifactExports}
        set
          "state" = 'failed',
          "attachment_id" = null,
          "updated_at" = now()
        where "id" = ${exportId}::uuid
          and "state" = 'ready'
          and "attachment_id" = ${attachmentId}::uuid
        returning "id"
      `);
      return invalidated !== undefined;
    },
  });
}
