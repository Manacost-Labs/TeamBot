import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { attachmentBlobs } from "../db/schema";
import {
  type AttachmentBlobMaintenance,
  type AttachmentBlobStore,
  executeFencedAttachmentUpload,
} from "./blob-store";
import type {
  AttachmentRecord,
  AttachmentReservation,
  AttachmentSource,
  AttachmentStore,
  FinalizeAttachmentInput,
} from "./store";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;

export type AttachmentLifecycleClaim = {
  storageKey: string;
  state: "uploading" | "publishing" | "deleting";
  claimToken: string;
  attempts: number;
};

export type AttachmentClaimLease = {
  completePublishing(): Promise<boolean>;
  completeDeletion(): Promise<boolean>;
};

export type AttachmentClaimResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

type AttachmentLifecycleClaimRow = Omit<
  AttachmentLifecycleClaim,
  "attempts"
> & { attempts: number | string };

/** Trusted worker boundary. Every completion is fenced by the token returned from claimDue. */
export type AttachmentLifecycleStore = {
  claimDue(
    limit?: number,
    leaseMs?: number,
  ): Promise<AttachmentLifecycleClaim[]>;
  withClaim<T>(
    claim: AttachmentLifecycleClaim,
    operation: (lease: AttachmentClaimLease) => Promise<T>,
  ): Promise<AttachmentClaimResult<T>>;
  releaseFailure(
    claim: AttachmentLifecycleClaim,
    nextAttemptAt: Date,
  ): Promise<boolean>;
};

function batchSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(requested)));
}

function claimLeaseMs(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_CLAIM_LEASE_MS;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error(
      "Attachment lifecycle lease must be a positive safe integer",
    );
  }
  return requested;
}

function mapClaim(row: AttachmentLifecycleClaimRow): AttachmentLifecycleClaim {
  return { ...row, attempts: Number(row.attempts) };
}

export function createAttachmentLifecycleStore(
  database: Database,
): AttachmentLifecycleStore {
  return {
    async claimDue(requestedLimit, requestedLeaseMs) {
      const limit = batchSize(requestedLimit);
      const leaseMs = claimLeaseMs(requestedLeaseMs);
      const rows = (await database.execute(sql`
        with "candidates" as (
          select "storage_key"
          from ${attachmentBlobs}
          where "state" in ('uploading', 'publishing', 'deleting')
            and "next_attempt_at" <= now()
            and ("lease_token" is null or "lease_expires_at" <= now())
          order by "next_attempt_at", "attempts", "storage_key"
          for update skip locked
          limit ${limit}
        )
        update ${attachmentBlobs}
        set
          "lease_token" = gen_random_uuid(),
          "lease_expires_at" = now() + (${leaseMs} * interval '1 millisecond'),
          "updated_at" = now()
        from "candidates"
        where ${attachmentBlobs.storageKey} = "candidates"."storage_key"
        returning
          ${attachmentBlobs.storageKey} as "storageKey",
          ${attachmentBlobs.state} as "state",
          ${attachmentBlobs.leaseToken} as "claimToken",
          ${attachmentBlobs.attempts} as "attempts"
      `)) as unknown as AttachmentLifecycleClaimRow[];
      return rows.map(mapClaim);
    },

    async withClaim(claim, operation) {
      return database.transaction(async (transaction) => {
        const [locked] = await transaction.execute<{ storageKey: string }>(sql`
          select "storage_key" as "storageKey"
          from ${attachmentBlobs}
          where "storage_key" = ${claim.storageKey}
            and "state" = ${claim.state}::attachment_blob_state
            and "lease_token" = ${claim.claimToken}::uuid
            and "lease_expires_at" > now()
          for update
        `);
        if (!locked) return { acquired: false } as const;

        const lease: AttachmentClaimLease = {
          async completePublishing() {
            const [row] = await transaction.execute<{ storageKey: string }>(sql`
              update ${attachmentBlobs}
              set
                "state" = 'live',
                "lease_token" = null,
                "lease_expires_at" = null,
                "attempts" = 0,
                "updated_at" = now()
              where "storage_key" = ${claim.storageKey}
                and "state" = 'publishing'
                and "lease_token" = ${claim.claimToken}::uuid
                and "lease_expires_at" > now()
              returning "storage_key" as "storageKey"
            `);
            return row !== undefined;
          },
          async completeDeletion() {
            const [row] = await transaction.execute<{ storageKey: string }>(sql`
              delete from ${attachmentBlobs}
              where "storage_key" = ${claim.storageKey}
                and "state" in ('uploading', 'deleting')
                and "lease_token" = ${claim.claimToken}::uuid
                and "lease_expires_at" > now()
              returning "storage_key" as "storageKey"
            `);
            return row !== undefined;
          },
        };
        return { acquired: true, value: await operation(lease) } as const;
      });
    },

    async releaseFailure(claim, nextAttemptAt) {
      if (!Number.isFinite(nextAttemptAt.getTime())) {
        throw new Error("Attachment retry time must be valid");
      }
      const [row] = await database.execute<{ storageKey: string }>(sql`
        update ${attachmentBlobs}
        set
          "attempts" = "attempts" + 1,
          "next_attempt_at" = ${nextAttemptAt},
          "lease_token" = null,
          "lease_expires_at" = null,
          "updated_at" = now()
        where "storage_key" = ${claim.storageKey}
          and "state" = ${claim.state}::attachment_blob_state
          and "lease_token" = ${claim.claimToken}::uuid
        returning "storage_key" as "storageKey"
      `);
      return row !== undefined;
    },
  };
}

export type AttachmentLifecycleReport = {
  claimed: number;
  completed: number;
  retried: number;
  lost: number;
};

/** Processes one bounded DB-claimed batch and never scans the filesystem namespace. */
export async function processAttachmentBlobLifecycle(options: {
  lifecycle: AttachmentLifecycleStore;
  maintenance: AttachmentBlobMaintenance;
  limit?: number;
  leaseMs?: number;
  now?: () => Date;
}): Promise<AttachmentLifecycleReport> {
  const claims = await options.lifecycle.claimDue(
    batchSize(options.limit),
    claimLeaseMs(options.leaseMs),
  );
  const report: AttachmentLifecycleReport = {
    claimed: claims.length,
    completed: 0,
    retried: 0,
    lost: 0,
  };

  for (const claim of claims) {
    try {
      const guarded = await options.maintenance.execute(
        options.lifecycle,
        claim,
      );
      if (!guarded.acquired) report.lost += 1;
      else if (guarded.value) report.completed += 1;
      else report.lost += 1;
    } catch {
      const now = (options.now ?? (() => new Date()))();
      if (!Number.isFinite(now.getTime())) {
        throw new Error("Attachment lifecycle clock returned an invalid date");
      }
      const retryMs = Math.min(
        MAX_RETRY_MS,
        BASE_RETRY_MS * 2 ** Math.min(claim.attempts, 20),
      );
      const released = await options.lifecycle.releaseFailure(
        claim,
        new Date(now.getTime() + retryMs),
      );
      if (released) report.retried += 1;
      else report.lost += 1;
    }
  }

  return report;
}

export type UploadAttachmentInput = Omit<
  FinalizeAttachmentInput,
  "sha256" | "size"
>;

type AttachmentUploadMetadataPort = Pick<
  AttachmentStore,
  "cancel" | "reserve" | "withUploadingLease"
>;

export type AttachmentUploadService = {
  reserve(
    actorUserId: string,
    channelId: string,
  ): Promise<AttachmentReservation | null>;
  upload(
    actorUserId: string,
    channelId: string,
    source: AttachmentSource,
    reservation: AttachmentReservation,
    input: UploadAttachmentInput,
    body: ReadableStream<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<AttachmentRecord | null>;
};

export class AttachmentUploadBusyError extends Error {
  readonly code = "ATTACHMENT_UPLOAD_BUSY" as const;

  constructor() {
    super("Attachment upload capacity is busy");
    this.name = "AttachmentUploadBusyError";
  }
}

/** The only upload API: DB fencing encloses temporary creation, metadata and publication. */
export function createAttachmentUploadService(options: {
  metadata: AttachmentUploadMetadataPort;
  blobs: AttachmentBlobStore;
  maxConcurrentUploads?: number;
}): AttachmentUploadService {
  const gate = new UploadConcurrencyGate(
    uploadConcurrency(options.maxConcurrentUploads),
  );
  return {
    reserve: (actorUserId, channelId) =>
      options.metadata.reserve(actorUserId, channelId),
    async upload(
      actorUserId,
      channelId,
      source,
      reservation,
      input,
      body,
      uploadOptions = {},
    ) {
      const unreadBody = unreadBodyCancellation(body);
      const releaseSlot = gate.tryEnter();
      if (!releaseSlot) {
        const busy = new AttachmentUploadBusyError();
        unreadBody.cancel(busy);
        void options.metadata
          .cancel(actorUserId, channelId, reservation)
          .catch(() => false);
        throw busy;
      }

      let deadline: ReturnType<typeof reservationDeadline> | undefined;
      try {
        deadline = reservationDeadline(
          reservation.leaseExpiresAt,
          uploadOptions.signal,
        );
        try {
          const attachment = await executeFencedAttachmentUpload({
            metadata: options.metadata,
            blobs: options.blobs,
            actorUserId,
            channelId,
            source,
            reservation,
            input,
            body,
            deadline,
            beforeRead: unreadBody.markRead,
          });
          if (!attachment) {
            deadline.signal.throwIfAborted();
            unreadBody.cancel(
              new Error("Attachment upload lease is no longer active"),
            );
          }
          return attachment;
        } catch (error) {
          unreadBody.cancel(error);
          throw error;
        }
      } finally {
        deadline?.dispose();
        releaseSlot();
      }
    },
  };
}

class UploadConcurrencyGate {
  private active = 0;

  constructor(private readonly limit: number) {}

  tryEnter(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

function uploadConcurrency(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_CONCURRENT_UPLOADS;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error(
      "Attachment upload concurrency must be a positive safe integer",
    );
  }
  return requested;
}

function unreadBodyCancellation(body: ReadableStream<Uint8Array>): {
  markRead(): void;
  cancel(reason: unknown): void;
} {
  let unread = true;
  return {
    markRead() {
      unread = false;
    },
    cancel(reason) {
      if (!unread) return;
      unread = false;
      void body.cancel(reason).catch(() => {});
    },
  };
}

function reservationDeadline(
  expiresAt: Date,
  externalSignal: AbortSignal | undefined,
): {
  signal: AbortSignal;
  bound(expiresAt: Date): void;
  dispose(): void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineMs = Number.POSITIVE_INFINITY;
  const expire = () => {
    controller.abort(new Error("Attachment reservation lease expired"));
  };
  const bound = (nextExpiresAt: Date) => {
    const nextDeadlineMs = nextExpiresAt.getTime();
    if (!Number.isFinite(nextDeadlineMs)) {
      throw new Error("Attachment reservation lease expiry must be valid");
    }
    deadlineMs = Math.min(deadlineMs, nextDeadlineMs);
    if (timer !== undefined) clearTimeout(timer);
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) expire();
    else timer = setTimeout(expire, remainingMs);
  };
  bound(expiresAt);
  const forwardAbort = () => {
    controller.abort(externalSignal?.reason ?? new Error("Upload aborted"));
  };
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  if (externalSignal?.aborted) forwardAbort();

  return {
    signal: controller.signal,
    bound,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}
