import { randomUUID } from "node:crypto";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  attachmentBlobs,
  type attachmentSource,
  attachments,
  channelMemberships,
  channels,
} from "../db/schema";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const RESERVATION_LEASE_MS = 5 * 60 * 1_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AttachmentSource = (typeof attachmentSource.enumValues)[number];
export type AttachmentRecord = typeof attachments.$inferSelect;
export type PublicAttachment = Omit<
  AttachmentRecord,
  "ownerUserId" | "storageKey"
>;

export type AttachmentReservation = {
  storageKey: string;
  leaseToken: string;
  leaseExpiresAt: Date;
};

/** Metadata produced by trusted upload/blob services, never deserialized directly from a route body. */
export type FinalizeAttachmentInput = {
  messageId?: string | null;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
};

export type AttachmentListQuery = {
  cursor?: string;
  limit?: number;
  messageId?: string;
};

export type AttachmentPage = {
  attachments: AttachmentRecord[];
  nextCursor: string | null;
};

export type AttachmentUploadLease = {
  expiresAt: Date;
  finalize(
    source: AttachmentSource,
    input: FinalizeAttachmentInput,
  ): Promise<AttachmentRecord | null>;
  markLive(): Promise<boolean>;
};

export type AttachmentLeaseResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

export class AttachmentQueryError extends Error {
  readonly code = "INVALID_CURSOR" as const;

  constructor() {
    super("cursor must be a valid attachment page cursor");
    this.name = "AttachmentQueryError";
  }
}

/** Every mutation proves actor, channel, state and current lease in the statement that changes it. */
export type AttachmentStore = {
  reserve(
    actorUserId: string,
    channelId: string,
  ): Promise<AttachmentReservation | null>;
  withUploadingLease<T>(
    actorUserId: string,
    channelId: string,
    reservation: AttachmentReservation,
    operation: (lease: AttachmentUploadLease) => Promise<T>,
  ): Promise<AttachmentLeaseResult<T>>;
  cancel(
    actorUserId: string,
    channelId: string,
    reservation: AttachmentReservation,
  ): Promise<boolean>;
  list(
    actorUserId: string,
    channelId: string,
    query?: AttachmentListQuery,
  ): Promise<AttachmentPage>;
  /** A bounded, owner-scoped index of generated artifacts across active channels. */
  listGenerated(
    actorUserId: string,
    query?: AttachmentListQuery,
  ): Promise<AttachmentPage>;
  get(
    actorUserId: string,
    channelId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null>;
  delete(
    actorUserId: string,
    channelId: string,
    attachmentId: string,
  ): Promise<boolean>;
};

type AttachmentSqlRow = Omit<AttachmentRecord, "createdAt" | "size"> & {
  createdAt: Date | string;
  size: bigint | number | string;
};

type ReservationSqlRow = Omit<AttachmentReservation, "leaseExpiresAt"> & {
  leaseExpiresAt: Date | string;
};

type AttachmentCursor = { createdAt: string; id: string };

const attachmentProjection = sql`
  "attachments"."id" as "id",
  "attachments"."owner_user_id" as "ownerUserId",
  "attachments"."channel_id" as "channelId",
  "attachments"."message_id" as "messageId",
  "attachments"."name" as "name",
  "attachments"."mime_type" as "mimeType",
  "attachments"."size" as "size",
  "attachments"."sha256" as "sha256",
  "attachments"."storage_key" as "storageKey",
  "attachments"."source" as "source",
  "attachments"."created_at" as "createdAt"
`;

function authorizedChannel(
  actorUserId: string,
  channelId: string | SQLWrapper,
): SQL {
  return sql`exists (
    select 1
    from ${channelMemberships}
    inner join ${channels}
      on ${channels.id} = ${channelMemberships.channelId}
    where ${channelMemberships.userId} = ${actorUserId}
      and ${channelMemberships.channelId} = ${channelId}
      and ${channels.deletedAt} is null
  )`;
}

function pageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)));
}

function encodeCursor(record: AttachmentRecord): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: record.createdAt.toISOString(),
      id: record.id,
    } satisfies AttachmentCursor),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string | undefined): AttachmentCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<AttachmentCursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !UUID.test(parsed.id)
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new AttachmentQueryError();
  }
}

function attachmentRecord(row: AttachmentSqlRow): AttachmentRecord {
  return {
    ...row,
    size: Number(row.size),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

function reservationRecord(row: ReservationSqlRow): AttachmentReservation {
  return {
    ...row,
    leaseExpiresAt:
      row.leaseExpiresAt instanceof Date
        ? row.leaseExpiresAt
        : new Date(row.leaseExpiresAt),
  };
}

function validReservation(reservation: AttachmentReservation): boolean {
  return UUID.test(reservation.storageKey) && UUID.test(reservation.leaseToken);
}

export function toPublicAttachment(record: AttachmentRecord): PublicAttachment {
  const {
    ownerUserId: _ownerUserId,
    storageKey: _storageKey,
    ...publicRow
  } = record;
  return publicRow;
}

export function createAttachmentStore(database: Database): AttachmentStore {
  return {
    async reserve(actorUserId, channelId) {
      const storageKey = randomUUID();
      const leaseToken = randomUUID();
      const [row] = (await database.execute(sql`
        insert into ${attachmentBlobs} (
          "storage_key", "state", "owner_user_id", "channel_id",
          "lease_token", "lease_expires_at"
        )
        select
          ${storageKey}, 'uploading'::attachment_blob_state, ${actorUserId}, ${channelId},
          ${leaseToken}::uuid, now() + (${RESERVATION_LEASE_MS} * interval '1 millisecond')
        where ${authorizedChannel(actorUserId, channelId)}
        returning
          "storage_key" as "storageKey",
          "lease_token" as "leaseToken",
          "lease_expires_at" as "leaseExpiresAt"
      `)) as unknown as ReservationSqlRow[];
      return row ? reservationRecord(row) : null;
    },

    async withUploadingLease(actorUserId, channelId, reservation, operation) {
      if (!validReservation(reservation)) return { acquired: false };
      return database.transaction(async (transaction) => {
        const [locked] = await transaction.execute<{
          storageKey: string;
          leaseExpiresAt: Date | string;
        }>(sql`
          select
            "storage_key" as "storageKey",
            "lease_expires_at" as "leaseExpiresAt"
          from ${attachmentBlobs}
          where "storage_key" = ${reservation.storageKey}
            and "state" = 'uploading'
            and "owner_user_id" = ${actorUserId}
            and "channel_id" = ${channelId}
            and "lease_token" = ${reservation.leaseToken}::uuid
            and "lease_expires_at" > now()
            and ${authorizedChannel(actorUserId, channelId)}
          for update
        `);
        if (!locked) return { acquired: false } as const;

        const lease: AttachmentUploadLease = {
          expiresAt:
            locked.leaseExpiresAt instanceof Date
              ? locked.leaseExpiresAt
              : new Date(locked.leaseExpiresAt),
          async finalize(source, input) {
            const [row] = (await transaction.execute(sql`
              with "transitioned" as (
                update ${attachmentBlobs}
                set "state" = 'publishing', "updated_at" = now()
                where "storage_key" = ${reservation.storageKey}
                  and "state" = 'uploading'
                  and "owner_user_id" = ${actorUserId}
                  and "channel_id" = ${channelId}
                  and "lease_token" = ${reservation.leaseToken}::uuid
                  and "lease_expires_at" > now()
                returning "storage_key"
              )
              insert into ${attachments} (
                "owner_user_id", "channel_id", "message_id", "name", "mime_type",
                "size", "sha256", "storage_key", "source"
              )
              select
                ${actorUserId}, ${channelId}, ${input.messageId ?? null}, ${input.name},
                ${input.mimeType}, ${input.size}, ${input.sha256}, "storage_key",
                ${source}::attachment_source
              from "transitioned"
              returning ${attachmentProjection}
            `)) as unknown as AttachmentSqlRow[];
            return row ? attachmentRecord(row) : null;
          },
          async markLive() {
            const [row] = await transaction.execute<{ storageKey: string }>(sql`
              update ${attachmentBlobs}
              set
                "state" = 'live',
                "lease_token" = null,
                "lease_expires_at" = null,
                "attempts" = 0,
                "updated_at" = now()
              where "storage_key" = ${reservation.storageKey}
                and "state" = 'publishing'
                and "owner_user_id" = ${actorUserId}
                and "channel_id" = ${channelId}
                and "lease_token" = ${reservation.leaseToken}::uuid
                and "lease_expires_at" > now()
              returning "storage_key" as "storageKey"
            `);
            return row !== undefined;
          },
        };
        return { acquired: true, value: await operation(lease) } as const;
      });
    },

    async cancel(actorUserId, channelId, reservation) {
      if (!validReservation(reservation)) return false;
      const [row] = await database.execute<{ storageKey: string }>(sql`
        update ${attachmentBlobs}
        set
          "state" = 'deleting',
          "lease_token" = null,
          "lease_expires_at" = null,
          "next_attempt_at" = now(),
          "updated_at" = now()
        where "storage_key" = ${reservation.storageKey}
          and "state" = 'uploading'
          and "owner_user_id" = ${actorUserId}
          and "channel_id" = ${channelId}
          and "lease_token" = ${reservation.leaseToken}::uuid
          and "lease_expires_at" > now()
        returning "storage_key" as "storageKey"
      `);
      return row !== undefined;
    },

    async list(actorUserId, channelId, query = {}) {
      const limit = pageSize(query.limit);
      const cursor = decodeCursor(query.cursor);
      const messageCondition =
        query.messageId === undefined
          ? sql``
          : sql`and "attachments"."message_id" = ${query.messageId}`;
      const cursorCondition = cursor
        ? sql`and (
            "attachments"."created_at" < ${cursor.createdAt}::timestamptz
            or ("attachments"."created_at" = ${cursor.createdAt}::timestamptz
              and "attachments"."id" < ${cursor.id}::uuid)
          )`
        : sql``;
      const rows = (await database.execute(sql`
        select ${attachmentProjection}
        from ${attachments}
        inner join ${attachmentBlobs}
          on ${attachmentBlobs.storageKey} = ${attachments.storageKey}
          and ${attachmentBlobs.state} = 'live'
        where ${attachments.ownerUserId} = ${actorUserId}
          and ${attachments.channelId} = ${channelId}
          and ${authorizedChannel(actorUserId, channelId)}
          ${messageCondition}
          ${cursorCondition}
        order by ${attachments.createdAt} desc, ${attachments.id} desc
        limit ${limit + 1}
      `)) as unknown as AttachmentSqlRow[];
      const records = rows.map(attachmentRecord);
      const page = records.slice(0, limit);
      const last = page.at(-1);
      return {
        attachments: page,
        nextCursor: records.length > limit && last ? encodeCursor(last) : null,
      };
    },

    async listGenerated(actorUserId, query = {}) {
      const limit = pageSize(query.limit);
      const cursor = decodeCursor(query.cursor);
      const cursorCondition = cursor
        ? sql`and (
            ${attachments.createdAt} < ${cursor.createdAt}::timestamptz
            or (${attachments.createdAt} = ${cursor.createdAt}::timestamptz
              and ${attachments.id} < ${cursor.id}::uuid)
          )`
        : sql``;
      const rows = (await database.execute(sql`
        select ${attachmentProjection}
        from ${attachments}
        inner join ${attachmentBlobs}
          on ${attachmentBlobs.storageKey} = ${attachments.storageKey}
          and ${attachmentBlobs.state} = 'live'
        where ${attachments.ownerUserId} = ${actorUserId}
          and ${attachments.source} = 'agent_generated'::attachment_source
          and ${attachments.messageId} like 'artifact:%'
          and ${authorizedChannel(actorUserId, attachments.channelId)}
          ${cursorCondition}
        order by ${attachments.createdAt} desc, ${attachments.id} desc
        limit ${limit + 1}
      `)) as unknown as AttachmentSqlRow[];
      const records = rows.map(attachmentRecord);
      const page = records.slice(0, limit);
      const last = page.at(-1);
      return {
        attachments: page,
        nextCursor: records.length > limit && last ? encodeCursor(last) : null,
      };
    },

    async get(actorUserId, channelId, attachmentId) {
      if (!UUID.test(attachmentId)) return null;
      const [row] = (await database.execute(sql`
        select ${attachmentProjection}
        from ${attachments}
        inner join ${attachmentBlobs}
          on ${attachmentBlobs.storageKey} = ${attachments.storageKey}
          and ${attachmentBlobs.state} = 'live'
        where ${attachments.id} = ${attachmentId}::uuid
          and ${attachments.ownerUserId} = ${actorUserId}
          and ${attachments.channelId} = ${channelId}
          and ${authorizedChannel(actorUserId, channelId)}
        limit 1
      `)) as unknown as AttachmentSqlRow[];
      return row ? attachmentRecord(row) : null;
    },

    async delete(actorUserId, channelId, attachmentId) {
      if (!UUID.test(attachmentId)) return false;
      const [row] = await database.execute<{ deleted: boolean }>(sql`
        with "target" as (
          select ${attachments.storageKey}
          from ${attachments}
          inner join ${attachmentBlobs}
            on ${attachmentBlobs.storageKey} = ${attachments.storageKey}
          where ${attachments.id} = ${attachmentId}::uuid
            and ${attachments.ownerUserId} = ${actorUserId}
            and ${attachments.channelId} = ${channelId}
            and ${attachmentBlobs.state} = 'live'
            and ${authorizedChannel(actorUserId, channelId)}
          for update of "attachments", "attachment_blobs"
        ),
        "transitioned" as (
          update ${attachmentBlobs}
          set
            "state" = 'deleting',
            "lease_token" = null,
            "lease_expires_at" = null,
            "next_attempt_at" = now(),
            "updated_at" = now()
          where "storage_key" in (select "storage_key" from "target")
            and "state" = 'live'
          returning "storage_key"
        ),
        "deleted" as (
          delete from ${attachments}
          where "storage_key" in (select "storage_key" from "transitioned")
          returning true as "deleted"
        )
        select "deleted" from "deleted"
      `);
      return row?.deleted ?? false;
    },
  };
}
