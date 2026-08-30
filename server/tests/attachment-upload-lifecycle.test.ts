import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AttachmentBlobStore,
  createAttachmentBlobMaintenance,
} from "../src/attachments/blob-store";
import {
  type AttachmentLifecycleClaim,
  AttachmentUploadBusyError,
  createAttachmentUploadService,
  processAttachmentBlobLifecycle,
} from "../src/attachments/lifecycle";
import type {
  AttachmentRecord,
  AttachmentReservation,
  AttachmentStore,
  FinalizeAttachmentInput,
} from "../src/attachments/store";
import {
  type StoredAttachmentValidationInput,
  validateStoredAttachment,
} from "../src/attachments/validation";

const cleanupRoots: string[] = [];
const storageKey = "20000000-0000-4000-8000-000000000001";
const leaseToken = "30000000-0000-4000-8000-000000000001";
const claimToken = "40000000-0000-4000-8000-000000000001";
const secondStorageKey = "20000000-0000-4000-8000-000000000002";
const thirdStorageKey = "20000000-0000-4000-8000-000000000003";
const fourthStorageKey = "20000000-0000-4000-8000-000000000004";
const fifthStorageKey = "20000000-0000-4000-8000-000000000005";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bytes(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function reservation(expiresInMs = 60_000): AttachmentReservation {
  return {
    storageKey,
    leaseToken,
    leaseExpiresAt: new Date(Date.now() + expiresInMs),
  };
}

function reservationFor(
  key: string,
  expiresInMs = 60_000,
): AttachmentReservation {
  return { ...reservation(expiresInMs), storageKey: key };
}

function trackedBody(value = "hello") {
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
    cancel() {
      cancellations += 1;
    },
  });
  return { stream, cancellations: () => cancellations };
}

function acceptStoredAttachment(input: StoredAttachmentValidationInput) {
  return Promise.resolve({
    name: input.name,
    mimeType: input.claimedMimeType,
  });
}

const record: AttachmentRecord = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerUserId: "user-a",
  channelId: "channel-a",
  messageId: null,
  name: "note.txt",
  mimeType: "text/plain",
  size: 5,
  sha256: "a".repeat(64),
  storageKey,
  source: "user_upload",
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
};

afterEach(async () => {
  await Promise.all(
    cleanupRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("fenced high-level attachment upload lifecycle", () => {
  test("cancels an unused reservation through the high-level service", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-cancel-"));
    cleanupRoots.push(parent);
    const blobs = new AttachmentBlobStore({ root: join(parent, "blobs") });
    const activeReservation = reservation();
    const cancellations: unknown[][] = [];
    const uploads = createAttachmentUploadService({
      blobs,
      validator: acceptStoredAttachment,
      metadata: {
        reserve: () => Promise.resolve(activeReservation),
        withUploadingLease: () => Promise.resolve({ acquired: false as const }),
        cancel: (...args) => {
          cancellations.push(args);
          return Promise.resolve(true);
        },
      },
    });

    await expect(
      uploads.cancel("user-a", "channel-a", activeReservation),
    ).resolves.toBe(true);
    expect(cancellations).toEqual([["user-a", "channel-a", activeReservation]]);
  });

  test("admits only N active uploads, rejects N+1 without queueing, and releases slots after success", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-gate-"));
    cleanupRoots.push(parent);
    const blobs = new AttachmentBlobStore({ root: join(parent, "blobs") });
    const releaseBodies = deferred();
    const activeEntered = deferred();
    let active = 0;
    const cancelledReservations: string[] = [];
    const metadata = {
      reserve: () => Promise.resolve(null),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        reserved: AttachmentReservation,
        operation: (lease: {
          expiresAt: Date;
          finalize(): Promise<AttachmentRecord | null>;
          markLive(): Promise<boolean>;
        }) => Promise<AttachmentRecord>,
      ) => {
        active += 1;
        if (active === 4) activeEntered.resolve();
        return {
          acquired: true as const,
          value: await operation({
            expiresAt: reserved.leaseExpiresAt,
            finalize: () =>
              Promise.resolve({ ...record, storageKey: reserved.storageKey }),
            markLive: () => Promise.resolve(true),
          }),
        };
      },
      cancel: (
        _actor: string,
        _channel: string,
        reserved: AttachmentReservation,
      ) => {
        cancelledReservations.push(reserved.storageKey);
        if (reserved.storageKey === fifthStorageKey) {
          return new Promise<boolean>(() => {});
        }
        return Promise.resolve(true);
      },
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: acceptStoredAttachment,
    });
    const stalledBody = () =>
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await releaseBodies.promise;
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      });
    const activeUploads = [
      storageKey,
      secondStorageKey,
      thirdStorageKey,
      fourthStorageKey,
    ].map((key, index) =>
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        reservationFor(key),
        { name: `${index + 1}.txt`, mimeType: "text/plain" },
        stalledBody(),
      ),
    );
    await activeEntered.promise;
    const overflowBody = trackedBody("overflow");

    const overflow = uploads.upload(
      "user-a",
      "channel-a",
      "user_upload",
      reservationFor(fifthStorageKey),
      { name: "five.txt", mimeType: "text/plain" },
      overflowBody.stream,
    );
    await expect(overflow).rejects.toBeInstanceOf(AttachmentUploadBusyError);
    expect(overflowBody.cancellations()).toBe(1);
    expect(active).toBe(4);
    expect(cancelledReservations).toContain(fifthStorageKey);

    releaseBodies.resolve();
    await Promise.all(activeUploads);

    const afterRelease = trackedBody("after");
    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        reservationFor(fifthStorageKey),
        { name: "after.txt", mimeType: "text/plain" },
        afterRelease.stream,
      ),
    ).resolves.toMatchObject({ storageKey: fifthStorageKey });
    expect(afterRelease.cancellations()).toBe(0);
  });

  test("releases an upload slot after an error", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-slot-error-"));
    cleanupRoots.push(parent);
    const blobs = new AttachmentBlobStore({ root: join(parent, "blobs") });
    const metadata = {
      reserve: () => Promise.resolve(null),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        reserved: AttachmentReservation,
        operation: (lease: {
          expiresAt: Date;
          finalize(): Promise<AttachmentRecord | null>;
          markLive(): Promise<boolean>;
        }) => Promise<AttachmentRecord>,
      ) => ({
        acquired: true as const,
        value: await operation({
          expiresAt: reserved.leaseExpiresAt,
          finalize: () =>
            Promise.resolve({ ...record, storageKey: reserved.storageKey }),
          markLive: () => Promise.resolve(true),
        }),
      }),
      cancel: () => Promise.resolve(true),
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: acceptStoredAttachment,
      maxConcurrentUploads: 1,
    });
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("body failed"));
      },
    });
    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        reservationFor(storageKey),
        { name: "broken.txt", mimeType: "text/plain" },
        broken,
      ),
    ).rejects.toThrow("body failed");

    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        reservationFor(secondStorageKey),
        { name: "working.txt", mimeType: "text/plain" },
        bytes("working"),
      ),
    ).resolves.toMatchObject({ storageKey: secondStorageKey });
  });

  test("cancels every unread stale, unacquired or pre-aborted body exactly once", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-unread-"));
    cleanupRoots.push(parent);
    const blobs = new AttachmentBlobStore({ root: join(parent, "blobs") });
    let revalidations = 0;
    const metadata = {
      reserve: () => Promise.resolve(null),
      withUploadingLease: () => {
        revalidations += 1;
        return Promise.resolve({ acquired: false as const });
      },
      cancel: () => Promise.resolve(false),
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: acceptStoredAttachment,
    });

    const stale = trackedBody();
    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        reservationFor(storageKey, -1),
        { name: "stale.txt", mimeType: "text/plain" },
        stale.stream,
      ),
    ).rejects.toThrow(/lease expired/i);
    expect(stale.cancellations()).toBe(1);

    const unacquired = trackedBody();
    expect(
      await uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        reservationFor(secondStorageKey),
        { name: "lost.txt", mimeType: "text/plain" },
        unacquired.stream,
      ),
    ).toBeNull();
    expect(unacquired.cancellations()).toBe(1);

    const aborted = trackedBody();
    const abort = new AbortController();
    abort.abort(new Error("caller aborted"));
    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        reservationFor(thirdStorageKey),
        { name: "aborted.txt", mimeType: "text/plain" },
        aborted.stream,
        { signal: abort.signal },
      ),
    ).rejects.toThrow("caller aborted");
    expect(aborted.cancellations()).toBe(1);
    expect(revalidations).toBe(1);
  });

  test("keeps body ownership with the service until the blob reader is acquired", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-ownership-"));
    cleanupRoots.push(parent);
    const blobs = new AttachmentBlobStore({ root: join(parent, "blobs") });
    const activeReservation = reservation();
    const abort = new AbortController();
    const body = trackedBody();
    const acquisitionError = new Error("reader acquisition aborted");
    Object.defineProperty(body.stream, "getReader", {
      value: () => {
        abort.abort(acquisitionError);
        throw acquisitionError;
      },
    });
    const metadata = {
      reserve: () => Promise.resolve(activeReservation),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        _reservation: AttachmentReservation,
        operation: Parameters<AttachmentStore["withUploadingLease"]>[3],
      ) => ({
        acquired: true as const,
        value: await operation({
          expiresAt: activeReservation.leaseExpiresAt,
          finalize: () => Promise.resolve(record),
          markLive: () => Promise.resolve(true),
        }),
      }),
      cancel: () => Promise.resolve(true),
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: acceptStoredAttachment,
    });

    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        activeReservation,
        { name: "ownership.txt", mimeType: "text/plain" },
        body.stream,
        { signal: abort.signal },
      ),
    ).rejects.toThrow("reader acquisition aborted");
    expect(body.cancellations()).toBe(1);
  });

  test("does not create a temp file when cleanup wins the per-key barrier before lease revalidation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-race-"));
    cleanupRoots.push(parent);
    const root = join(parent, "blobs");
    const blobs = new AttachmentBlobStore({ root });
    const cleanupEntered = deferred();
    const allowCleanup = deferred();
    let uploadRevalidations = 0;
    const staleReservation = reservation();
    const cleanupClaim: AttachmentLifecycleClaim = {
      storageKey,
      claimToken,
      state: "uploading",
      attempts: 0,
    };

    const lifecycle = {
      claimDue: () => Promise.resolve([cleanupClaim]),
      withClaim: async (
        _claim: AttachmentLifecycleClaim,
        operation: (lease: {
          completeDeletion(): Promise<boolean>;
          completePublishing(): Promise<boolean>;
        }) => Promise<boolean>,
      ) => {
        cleanupEntered.resolve();
        await allowCleanup.promise;
        return {
          acquired: true as const,
          value: await operation({
            completeDeletion: () => Promise.resolve(true),
            completePublishing: () => Promise.resolve(false),
          }),
        };
      },
      releaseFailure: () => Promise.resolve(true),
    };
    const metadata = {
      reserve: () => Promise.resolve(staleReservation),
      withUploadingLease: () => {
        uploadRevalidations += 1;
        return Promise.resolve({ acquired: false as const });
      },
      cancel: () => Promise.resolve(false),
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: acceptStoredAttachment,
    });

    const cleanup = processAttachmentBlobLifecycle({
      lifecycle,
      maintenance: createAttachmentBlobMaintenance(blobs),
    });
    await cleanupEntered.promise;
    const upload = uploads.upload(
      "user-a",
      "channel-a",
      "user_upload",
      staleReservation,
      { name: "note.txt", mimeType: "text/plain" },
      bytes("hello"),
    );
    await Promise.resolve();
    expect(uploadRevalidations).toBe(0);

    allowCleanup.resolve();
    expect(await cleanup).toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      lost: 0,
    });
    expect(await upload).toBeNull();
    expect(uploadRevalidations).toBe(1);
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });

  test("writes, finalizes, publishes and marks live only inside the revalidated lease callback", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-flow-"));
    cleanupRoots.push(parent);
    const blobs = new AttachmentBlobStore({ root: join(parent, "blobs") });
    const activeReservation = reservation();
    const calls: string[] = [];
    let finalizedInput: FinalizeAttachmentInput | undefined;
    const metadata = {
      reserve: () => Promise.resolve(activeReservation),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        _reservation: AttachmentReservation,
        operation: (lease: {
          finalize(): Promise<AttachmentRecord | null>;
          markLive(): Promise<boolean>;
        }) => Promise<AttachmentRecord>,
      ) => {
        calls.push("revalidated");
        return {
          acquired: true as const,
          value: await operation({
            expiresAt: activeReservation.leaseExpiresAt,
            finalize: (_source, input) => {
              calls.push("finalized");
              finalizedInput = input;
              return Promise.resolve(record);
            },
            markLive: () => {
              calls.push("live");
              return Promise.resolve(true);
            },
          }),
        };
      },
      cancel: () => Promise.resolve(false),
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: async (input) => {
        expect(await new Response(await input.openStream?.()).text()).toBe(
          "hello",
        );
        calls.push("validated");
        return { name: "note.txt", mimeType: "text/plain" };
      },
    });

    expect(
      await uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        activeReservation,
        { name: "  note.txt  ", mimeType: " TEXT/PLAIN " },
        bytes("hello"),
      ),
    ).toEqual(record);
    expect(calls).toEqual(["revalidated", "validated", "finalized", "live"]);
    expect(finalizedInput).toMatchObject({
      name: "note.txt",
      mimeType: "text/plain",
    });
    expect(
      new Uint8Array(
        await new Response(await blobs.open(storageKey)).arrayBuffer(),
      ),
    ).toEqual(new TextEncoder().encode("hello"));
  });

  test("validation failure removes the temporary blob, cancels the reservation and creates no metadata", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-invalid-"));
    cleanupRoots.push(parent);
    const root = join(parent, "blobs");
    const blobs = new AttachmentBlobStore({ root });
    const activeReservation = reservation();
    let finalized = 0;
    let markedLive = 0;
    let cancelled = 0;
    const metadata = {
      reserve: () => Promise.resolve(activeReservation),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        _reservation: AttachmentReservation,
        operation: Parameters<AttachmentStore["withUploadingLease"]>[3],
      ) => ({
        acquired: true as const,
        value: await operation({
          expiresAt: activeReservation.leaseExpiresAt,
          finalize: () => {
            finalized += 1;
            return Promise.resolve(record);
          },
          markLive: () => {
            markedLive += 1;
            return Promise.resolve(true);
          },
        }),
      }),
      cancel: () => {
        cancelled += 1;
        return Promise.resolve(true);
      },
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: validateStoredAttachment,
    });

    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        activeReservation,
        { name: "image.png", mimeType: "image/png" },
        bytes("not a png"),
      ),
    ).rejects.toMatchObject({ code: "invalid_content" });
    expect({ finalized, markedLive, cancelled }).toEqual({
      finalized: 0,
      markedLive: 0,
      cancelled: 1,
    });
    expect(await readdir(root).catch(() => [])).toEqual([]);
    await expect(blobs.open(storageKey)).rejects.toThrow(/not found/i);
  });

  test("lease expiry stops a never-settling validator and releases the upload slot", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "teambot-upload-validation-deadline-"),
    );
    cleanupRoots.push(parent);
    const root = join(parent, "blobs");
    const blobs = new AttachmentBlobStore({ root });
    const expiringReservation = reservation();
    const validatorEntered = deferred();
    let validatorCalls = 0;
    let finalized = 0;
    let markedLive = 0;
    let cancelled = 0;
    const metadata = {
      reserve: () => Promise.resolve(expiringReservation),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        reserved: AttachmentReservation,
        operation: Parameters<AttachmentStore["withUploadingLease"]>[3],
      ) => ({
        acquired: true as const,
        value: await operation({
          expiresAt:
            reserved.storageKey === storageKey
              ? new Date(Date.now() + 40)
              : reserved.leaseExpiresAt,
          finalize: () => {
            finalized += 1;
            return Promise.resolve({
              ...record,
              storageKey: reserved.storageKey,
            });
          },
          markLive: () => {
            markedLive += 1;
            return Promise.resolve(true);
          },
        }),
      }),
      cancel: () => {
        cancelled += 1;
        return Promise.resolve(true);
      },
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      maxConcurrentUploads: 1,
      validator: (input) => {
        validatorCalls += 1;
        if (validatorCalls === 1) {
          validatorEntered.resolve();
          return new Promise(() => {});
        }
        return acceptStoredAttachment(input);
      },
    });
    const firstUpload = uploads.upload(
      "user-a",
      "channel-a",
      "user_upload",
      expiringReservation,
      { name: "stalled.txt", mimeType: "text/plain" },
      bytes("hello"),
    );
    const firstResult = firstUpload.then(
      () => new Error("validation upload unexpectedly succeeded"),
      (error: unknown) => error,
    );
    await validatorEntered.promise;
    const expiryError = await Promise.race([
      firstResult,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("validation deadline did not fire")),
          2_000,
        );
      }),
    ]);
    expect(expiryError).toBeInstanceOf(Error);
    expect((expiryError as Error).message).toMatch(/lease expired/i);
    expect({ finalized, markedLive, cancelled }).toEqual({
      finalized: 0,
      markedLive: 0,
      cancelled: 1,
    });
    expect(await readdir(root)).toEqual([]);

    await expect(
      Promise.race([
        uploads.upload(
          "user-a",
          "channel-a",
          "user_upload",
          reservationFor(secondStorageKey),
          { name: "next.txt", mimeType: "text/plain" },
          bytes("next"),
        ),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("upload slot was not reusable")),
            2_000,
          );
        }),
      ]),
    ).resolves.toMatchObject({ storageKey: secondStorageKey });
    expect({ finalized, markedLive, cancelled }).toEqual({
      finalized: 1,
      markedLive: 1,
      cancelled: 1,
    });
  });

  test("holds the validated temp blob behind the parser barrier and cleans it when parsing fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-parser-"));
    cleanupRoots.push(parent);
    const root = join(parent, "blobs");
    const blobs = new AttachmentBlobStore({ root });
    const activeReservation = reservation();
    const validated = deferred();
    let rejectParser = (_reason: unknown) => {};
    const parserFinished = new Promise<void>((_resolve, reject) => {
      rejectParser = reject;
    });
    let finalized = 0;
    let markedLive = 0;
    let cancelled = 0;
    const metadata = {
      reserve: () => Promise.resolve(activeReservation),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        _reservation: AttachmentReservation,
        operation: Parameters<AttachmentStore["withUploadingLease"]>[3],
      ) => ({
        acquired: true as const,
        value: await operation({
          expiresAt: activeReservation.leaseExpiresAt,
          finalize: () => {
            finalized += 1;
            return Promise.resolve(record);
          },
          markLive: () => {
            markedLive += 1;
            return Promise.resolve(true);
          },
        }),
      }),
      cancel: () => {
        cancelled += 1;
        return Promise.resolve(true);
      },
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: async (input) => {
        await acceptStoredAttachment(input);
        validated.resolve();
        return new Promise(() => {});
      },
    });

    const upload = uploads.upload(
      "user-a",
      "channel-a",
      "user_upload",
      activeReservation,
      { name: "note.txt", mimeType: "text/plain" },
      bytes("hello"),
      { readyToFinalize: parserFinished },
    );
    await validated.promise;
    expect(finalized).toBe(0);
    expect(await readdir(root)).toEqual([`.tmp-${storageKey}`]);

    rejectParser(new Error("multipart contains an unexpected part"));
    await expect(
      Promise.race([
        upload,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("parser rejection was not prompt")),
            2_000,
          );
        }),
      ]),
    ).rejects.toThrow("unexpected part");
    expect({ finalized, markedLive, cancelled }).toEqual({
      finalized: 0,
      markedLive: 0,
      cancelled: 1,
    });
    expect(await readdir(root)).toEqual([]);
  });

  test("gives the trusted OOXML validator callback-scoped access to the temporary file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-ooxml-"));
    cleanupRoots.push(parent);
    const blobs = new AttachmentBlobStore({ root: join(parent, "blobs") });
    const activeReservation = reservation();
    const archiveBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    let inspectedPath = "";
    const metadata = {
      reserve: () => Promise.resolve(activeReservation),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        _reservation: AttachmentReservation,
        operation: Parameters<AttachmentStore["withUploadingLease"]>[3],
      ) => ({
        acquired: true as const,
        value: await operation({
          expiresAt: activeReservation.leaseExpiresAt,
          finalize: () =>
            Promise.resolve({
              ...record,
              name: "report.docx",
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: archiveBytes.byteLength,
            }),
          markLive: () => Promise.resolve(true),
        }),
      }),
      cancel: () => Promise.resolve(false),
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: async (input) => {
        expect(input.withFilePath).toBeFunction();
        return input.withFilePath?.(async (path) => {
          inspectedPath = path;
          expect(basename(path)).toBe(`.tmp-${storageKey}`);
          expect(new Uint8Array(await readFile(path))).toEqual(archiveBytes);
          return {
            name: input.name,
            mimeType: input.claimedMimeType,
          };
        }) as Promise<{ name: string; mimeType: string }>;
      },
    });

    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        activeReservation,
        {
          name: "report.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        new ReadableStream({
          start(controller) {
            controller.enqueue(archiveBytes);
            controller.close();
          },
        }),
      ),
    ).resolves.toMatchObject({ name: "report.docx" });
    expect(inspectedPath).not.toBe("");
    expect(await readdir(join(parent, "blobs"))).toEqual([storageKey]);
  });

  test("aborts a stalled body at the reservation deadline and leaves no untracked file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "teambot-upload-deadline-"));
    cleanupRoots.push(parent);
    const root = join(parent, "blobs");
    const blobs = new AttachmentBlobStore({ root });
    const expiringReservation = reservation(60_000);
    const databaseLeaseExpiresAt = new Date(Date.now() + 40);
    let cancelled = 0;
    const metadata = {
      reserve: () => Promise.resolve(expiringReservation),
      withUploadingLease: async (
        _actor: string,
        _channel: string,
        _reservation: AttachmentReservation,
        operation: (lease: {
          finalize(): Promise<AttachmentRecord | null>;
          markLive(): Promise<boolean>;
        }) => Promise<AttachmentRecord>,
      ) => ({
        acquired: true as const,
        value: await operation({
          expiresAt: databaseLeaseExpiresAt,
          finalize: () => Promise.resolve(record),
          markLive: () => Promise.resolve(true),
        }),
      }),
      cancel: () => {
        cancelled += 1;
        return Promise.resolve(true);
      },
    };
    const uploads = createAttachmentUploadService({
      metadata,
      blobs,
      validator: acceptStoredAttachment,
    });
    const fallback = new AbortController();
    const fallbackTimer = setTimeout(
      () => fallback.abort(new Error("test timeout")),
      250,
    );
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
    });

    await expect(
      uploads.upload(
        "user-a",
        "channel-a",
        "user_upload",
        expiringReservation,
        { name: "note.txt", mimeType: "text/plain" },
        stalled,
        { signal: fallback.signal },
      ),
    ).rejects.toThrow(/lease expired/i);
    clearTimeout(fallbackTimer);
    expect(cancelled).toBe(1);
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });
});
