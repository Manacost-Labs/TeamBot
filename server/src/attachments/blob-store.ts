import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open as openFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type {
  AttachmentLifecycleClaim,
  AttachmentLifecycleStore,
} from "./lifecycle";
import type {
  AttachmentRecord,
  AttachmentReservation,
  AttachmentSource,
  AttachmentStore,
  FinalizeAttachmentInput,
} from "./store";
import type {
  StoredAttachmentValidationInput,
  ValidatedAttachmentMetadata,
} from "./validation";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const ROOT_MODE = 0o700;
const FILE_MODE = 0o600;
const STORAGE_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type StoredAttachmentBlob = {
  storageKey: string;
  size: number;
  sha256: string;
};

type AttachmentBlobStoreOptions = {
  root: string;
  maxBytes?: number;
  durability?: AttachmentBlobDurability;
};

type WriteOptions = {
  signal?: AbortSignal;
  onReaderAcquired?(): void;
};

export type AttachmentBlobPresence = {
  temporary: boolean;
  live: boolean;
};

export type AttachmentBlobDurability = {
  syncFile(handle: FileHandle): Promise<void>;
  syncDirectory(path: string): Promise<void>;
};

type AttachmentBlobLease = {
  writeTemporary(
    source: ReadableStream<Uint8Array>,
    options?: WriteOptions,
  ): Promise<StoredAttachmentBlob>;
  openTemporary(): Promise<ReadableStream<Uint8Array>>;
  withTemporaryFilePath<Value>(
    inspect: (internalPath: string) => Promise<Value>,
  ): Promise<Value>;
  inspect(): Promise<AttachmentBlobPresence>;
  publish(): Promise<boolean>;
  delete(): Promise<boolean>;
};

const durableFilesystem: AttachmentBlobDurability = {
  syncFile: (handle) => handle.sync(),
  async syncDirectory(path) {
    const handle = await openFile(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/** A streaming, private filesystem store for attachment bytes. */
export class AttachmentBlobStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly durability: AttachmentBlobDurability;
  private readonly keyTails = new Map<string, Promise<void>>();

  constructor({
    root,
    maxBytes = DEFAULT_MAX_BYTES,
    durability = durableFilesystem,
  }: AttachmentBlobStoreOptions) {
    if (!root.trim()) throw new Error("Attachment storage root is required");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Attachment maxBytes must be a positive safe integer");
    }
    this.root = resolve(root);
    this.maxBytes = maxBytes;
    this.durability = durability;
    blobStoreInternals.set(this, {
      withKey: this.withKey.bind(this),
    });
  }

  private async withKey<T>(
    storageKey: string,
    operation: (lease: AttachmentBlobLease) => Promise<T>,
  ): Promise<T> {
    this.assertStorageKey(storageKey);
    const previous = this.keyTails.get(storageKey) ?? Promise.resolve();
    let release = () => {};
    const turn = new Promise<void>((done) => {
      release = done;
    });
    const tail = previous.catch(() => {}).then(() => turn);
    this.keyTails.set(storageKey, tail);
    await previous.catch(() => {});

    try {
      return await operation({
        writeTemporary: (source, options) =>
          this.writeTemporary(storageKey, source, options),
        openTemporary: () => this.openTemporary(storageKey),
        withTemporaryFilePath: (inspect) =>
          this.withTemporaryFilePath(storageKey, inspect),
        inspect: () => this.inspect(storageKey),
        publish: () => this.publish(storageKey),
        delete: () => this.delete(storageKey),
      });
    } finally {
      release();
      if (this.keyTails.get(storageKey) === tail) {
        this.keyTails.delete(storageKey);
      }
    }
  }

  private async writeTemporary(
    storageKey: string,
    source: ReadableStream<Uint8Array>,
    options: WriteOptions = {},
  ): Promise<StoredAttachmentBlob> {
    this.assertStorageKey(storageKey);
    options.signal?.throwIfAborted();
    await this.ensurePrivateRoot();

    const targetPath = this.pathFor(storageKey);
    const temporaryPath = this.temporaryPathFor(storageKey);
    const reader = source.getReader();
    options.onReaderAcquired?.();
    const hash = createHash("sha256");
    let size = 0;
    let handle: FileHandle | null = null;
    let temporaryExists = false;
    let completed = false;

    try {
      if ((await pathKind(targetPath)) || (await pathKind(temporaryPath))) {
        throw new Error("Attachment storage key collision");
      }
      handle = await openFile(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        FILE_MODE,
      );
      temporaryExists = true;
      await handle.chmod(FILE_MODE);
      await this.durability.syncDirectory(this.root);

      while (true) {
        const next = await readWithAbort(reader, options.signal);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) {
          throw new TypeError(
            "Attachment stream must contain Uint8Array chunks",
          );
        }
        const nextSize = size + next.value.byteLength;
        if (!Number.isSafeInteger(nextSize) || nextSize > this.maxBytes) {
          throw new Error(
            `Attachment exceeds the configured limit of ${this.maxBytes} bytes`,
          );
        }
        options.signal?.throwIfAborted();
        await writeAll(handle, next.value, options.signal);
        hash.update(next.value);
        size = nextSize;
      }

      options.signal?.throwIfAborted();
      if (size === 0) throw new Error("Attachment cannot be empty");
      await handle.chmod(FILE_MODE);
      await this.durability.syncFile(handle);
      await handle.close();
      handle = null;

      completed = true;
      return { storageKey, size, sha256: hash.digest("hex") };
    } finally {
      if (!completed) {
        void reader.cancel(options.signal?.reason).catch(() => {});
      }
      try {
        reader.releaseLock();
      } catch {
        // A pending read releases after cancellation. It has no writer once this method exits.
      }
      if (handle) {
        await handle.close().catch(() => {});
      }
      if (!completed && temporaryExists) {
        await this.unlinkIfPresent(temporaryPath);
      }
    }
  }

  private async inspect(storageKey: string): Promise<AttachmentBlobPresence> {
    this.assertStorageKey(storageKey);
    await this.ensurePrivateRoot();
    const temporary = await this.inspectBlobPath(
      this.temporaryPathFor(storageKey),
      "temporary attachment blob",
    );
    const live = await this.inspectBlobPath(
      this.pathFor(storageKey),
      "attachment blob",
    );
    return { temporary, live };
  }

  private async publish(storageKey: string): Promise<boolean> {
    this.assertStorageKey(storageKey);
    await this.ensurePrivateRoot();
    const temporaryPath = this.temporaryPathFor(storageKey);
    const targetPath = this.pathFor(storageKey);
    const presence = await this.inspect(storageKey);
    if (presence.temporary && presence.live) {
      throw new Error("Attachment blob has both temporary and live files");
    }
    if (presence.live) return false;
    if (!presence.temporary) throw new Error("Attachment blob not found");

    await this.ensurePrivateRoot();
    try {
      await rename(temporaryPath, targetPath);
      await this.durability.syncDirectory(this.root);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        const afterRace = await this.inspect(storageKey);
        if (afterRace.live && !afterRace.temporary) return false;
        throw new Error("Attachment blob not found", { cause: error });
      }
      throw error;
    }
  }

  async open(storageKey: string): Promise<ReadableStream<Uint8Array>> {
    this.assertStorageKey(storageKey);
    await this.ensurePrivateRoot();
    return this.openBlobPath(this.pathFor(storageKey), "attachment blob");
  }

  private async openTemporary(
    storageKey: string,
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertStorageKey(storageKey);
    await this.ensurePrivateRoot();
    return this.openBlobPath(
      this.temporaryPathFor(storageKey),
      "temporary attachment blob",
    );
  }

  private async withTemporaryFilePath<Value>(
    storageKey: string,
    inspect: (internalPath: string) => Promise<Value>,
  ): Promise<Value> {
    this.assertStorageKey(storageKey);
    await this.ensurePrivateRoot();
    const temporaryPath = this.temporaryPathFor(storageKey);
    if (
      !(await this.inspectBlobPath(temporaryPath, "temporary attachment blob"))
    ) {
      throw new Error("Temporary attachment blob not found");
    }
    if ((await realpath(temporaryPath)) !== temporaryPath) {
      throw new Error("Temporary attachment blob cannot be a symbolic link");
    }
    return inspect(temporaryPath);
  }

  private async openBlobPath(
    targetPath: string,
    label: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const kind = await pathKind(targetPath);
    if (kind === null) throw new Error("Attachment blob not found");
    if (kind === "symlink") {
      throw new Error(`${label} cannot be a symbolic link`);
    }
    if (kind !== "file") throw new Error(`${label} is not a file`);

    let handle: FileHandle | null = null;
    try {
      handle = await openFile(
        targetPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error(`${label} is not a file`);
      const nodeStream = handle.createReadStream({ autoClose: true });
      handle = null;
      return Readable.toWeb(
        nodeStream,
      ) as unknown as ReadableStream<Uint8Array>;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (hasCode(error, "ENOENT")) {
        throw new Error("Attachment blob not found", { cause: error });
      }
      if (hasCode(error, "ELOOP")) {
        throw new Error(`${label} cannot be a symbolic link`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async delete(storageKey: string): Promise<boolean> {
    this.assertStorageKey(storageKey);
    await this.ensurePrivateRoot();
    const temporaryPath = this.temporaryPathFor(storageKey);
    const targetPath = this.pathFor(storageKey);
    const presence = await this.inspect(storageKey);
    let deleted = false;
    if (presence.temporary) {
      deleted = (await this.unlinkIfPresent(temporaryPath)) || deleted;
    }
    if (presence.live) {
      deleted = (await this.unlinkIfPresent(targetPath)) || deleted;
    }
    return deleted;
  }

  private assertStorageKey(storageKey: string): void {
    if (!STORAGE_KEY.test(storageKey)) {
      throw new Error("Invalid attachment storage key");
    }
  }

  private pathFor(storageKey: string): string {
    return join(this.root, storageKey);
  }

  private temporaryPathFor(storageKey: string): string {
    return join(this.root, `.tmp-${storageKey}`);
  }

  private async inspectBlobPath(path: string, label: string): Promise<boolean> {
    const kind = await pathKind(path);
    if (kind === null) return false;
    if (kind === "symlink") {
      throw new Error(`${label} cannot be a symbolic link`);
    }
    if (kind !== "file") throw new Error(`${label} is not a file`);
    return true;
  }

  private async unlinkIfPresent(path: string): Promise<boolean> {
    try {
      await unlink(path);
      await this.durability.syncDirectory(this.root);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async ensurePrivateRoot(): Promise<void> {
    let kind = await pathKind(this.root);
    if (kind === null) {
      await mkdir(this.root, { recursive: true, mode: ROOT_MODE });
      kind = await pathKind(this.root);
    }
    if (kind === "symlink") {
      throw new Error("Attachment storage root cannot be a symbolic link");
    }
    if (kind !== "directory") {
      throw new Error("Attachment storage root is not a directory");
    }

    const canonicalRoot = await realpath(this.root);
    if (canonicalRoot !== this.root) {
      throw new Error("Attachment storage root cannot contain a symbolic link");
    }
    await chmod(this.root, ROOT_MODE);
  }
}

type InternalAttachmentBlobStore = {
  withKey<T>(
    storageKey: string,
    operation: (lease: AttachmentBlobLease) => Promise<T>,
  ): Promise<T>;
};

const blobStoreInternals = new WeakMap<
  AttachmentBlobStore,
  InternalAttachmentBlobStore
>();

function withAttachmentBlobKey<T>(
  store: AttachmentBlobStore,
  storageKey: string,
  operation: (lease: AttachmentBlobLease) => Promise<T>,
): Promise<T> {
  const internal =
    blobStoreInternals.get(store) ??
    (store as unknown as InternalAttachmentBlobStore);
  return internal.withKey(storageKey, operation);
}

type AttachmentUploadMetadataPort = Pick<
  AttachmentStore,
  "cancel" | "withUploadingLease"
>;

type AttachmentUploadDeadline = {
  signal: AbortSignal;
  bound(expiresAt: Date): void;
};

export type AttachmentStoredValidator = (
  input: StoredAttachmentValidationInput,
) => Promise<ValidatedAttachmentMetadata>;

/** Composition-only upload flow. It never returns a raw filesystem mutation capability. */
export async function executeFencedAttachmentUpload(options: {
  metadata: AttachmentUploadMetadataPort;
  blobs: AttachmentBlobStore;
  actorUserId: string;
  channelId: string;
  source: AttachmentSource;
  reservation: AttachmentReservation;
  input: Omit<FinalizeAttachmentInput, "sha256" | "size">;
  body: ReadableStream<Uint8Array>;
  validator: AttachmentStoredValidator;
  readyToFinalize?: Promise<void>;
  deadline: AttachmentUploadDeadline;
  beforeRead(): void;
}): Promise<AttachmentRecord | null> {
  let operationFailed = false;
  return withAttachmentBlobKey(
    options.blobs,
    options.reservation.storageKey,
    async (blob) => {
      options.deadline.signal.throwIfAborted();
      try {
        const guarded = await options.metadata.withUploadingLease(
          options.actorUserId,
          options.channelId,
          options.reservation,
          async (lease) => {
            options.deadline.bound(lease.expiresAt);
            options.deadline.signal.throwIfAborted();
            try {
              const stored = await blob.writeTemporary(options.body, {
                signal: options.deadline.signal,
                onReaderAcquired: options.beforeRead,
              });
              options.deadline.signal.throwIfAborted();
              let validationActive = true;
              const requireValidationScope = () => {
                if (!validationActive) {
                  throw new Error("Attachment validation access expired");
                }
              };
              let validated: ValidatedAttachmentMetadata;
              try {
                const validation = Promise.resolve().then(() =>
                  options.validator({
                    name: options.input.name,
                    claimedMimeType: options.input.mimeType,
                    openStream: () => {
                      requireValidationScope();
                      return blob.openTemporary();
                    },
                    withFilePath: (inspect) => {
                      requireValidationScope();
                      return blob.withTemporaryFilePath(
                        async (internalPath) => {
                          requireValidationScope();
                          return inspect(internalPath);
                        },
                      );
                    },
                  }),
                );
                validated = await waitForValidationAndBarrier(
                  validation,
                  options.readyToFinalize,
                  options.deadline.signal,
                );
              } finally {
                validationActive = false;
              }
              options.deadline.signal.throwIfAborted();
              const attachment = await lease.finalize(options.source, {
                ...options.input,
                name: validated.name,
                mimeType: validated.mimeType,
                size: stored.size,
                sha256: stored.sha256,
              });
              if (!attachment) {
                throw new Error("Attachment upload lease changed");
              }
              options.deadline.signal.throwIfAborted();
              await blob.publish();
              options.deadline.signal.throwIfAborted();
              if (!(await lease.markLive())) {
                throw new Error("Attachment upload lease expired");
              }
              return attachment;
            } catch (error) {
              operationFailed = true;
              await blob.delete().catch(() => false);
              throw error;
            }
          },
        );
        return guarded.acquired ? guarded.value : null;
      } catch (error) {
        if (operationFailed) {
          await options.metadata
            .cancel(options.actorUserId, options.channelId, options.reservation)
            .catch(() => false);
        }
        throw error;
      }
    },
  );
}

async function executeAttachmentBlobClaim(
  blobs: AttachmentBlobStore,
  lifecycle: AttachmentLifecycleStore,
  claim: AttachmentLifecycleClaim,
) {
  return withAttachmentBlobKey(blobs, claim.storageKey, async (blob) =>
    lifecycle.withClaim(claim, async (lease) => {
      if (claim.state === "publishing") {
        const presence = await blob.inspect();
        if (presence.temporary && !presence.live) {
          await blob.publish();
        } else if (!presence.live || presence.temporary) {
          throw new Error("Attachment publishing state is inconsistent");
        }
        return lease.completePublishing();
      }

      await blob.delete();
      return lease.completeDeletion();
    }),
  );
}

/** Opaque composition port: lifecycle workers can run claims but cannot obtain a raw blob lease. */
export type AttachmentBlobMaintenance = {
  execute(
    lifecycle: AttachmentLifecycleStore,
    claim: AttachmentLifecycleClaim,
  ): ReturnType<typeof executeAttachmentBlobClaim>;
};

export function createAttachmentBlobMaintenance(
  blobs: AttachmentBlobStore,
): AttachmentBlobMaintenance {
  return Object.freeze({
    execute: (lifecycle, claim) =>
      executeAttachmentBlobClaim(blobs, lifecycle, claim),
  });
}

type UnsafePublicBlobMutation = Extract<
  keyof AttachmentBlobStore,
  | "delete"
  | "inspect"
  | "openTemporary"
  | "publish"
  | "withFilePath"
  | "withKey"
  | "withTemporaryFilePath"
  | "writeTemporary"
>;
const attachmentBlobStoreHasNoPublicMutation: UnsafePublicBlobMutation extends never
  ? true
  : false = true;
void attachmentBlobStoreHasNoPublicMutation;

async function waitForValidationAndBarrier(
  validation: Promise<ValidatedAttachmentMetadata>,
  ready: Promise<void> | undefined,
  signal: AbortSignal,
): Promise<ValidatedAttachmentMetadata> {
  signal.throwIfAborted();
  const barrier = ready ?? Promise.resolve();
  // Both tasks may outlive a fail-fast abort. Keep their eventual rejections observed.
  void validation.catch(() => {});
  void barrier.catch(() => {});
  const combined = Promise.all([validation, barrier]).then(
    ([validated]) => validated,
  );

  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Upload aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const validated = await Promise.race([combined, aborted]);
    signal.throwIfAborted();
    return validated;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!signal) return reader.read();

  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Upload aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function writeAll(
  handle: FileHandle,
  chunk: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    signal?.throwIfAborted();
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten < 1) throw new Error("Attachment write made no progress");
    offset += bytesWritten;
  }
}

async function pathKind(
  path: string,
): Promise<"directory" | "file" | "other" | "symlink" | null> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return "symlink";
    if (entry.isDirectory()) return "directory";
    if (entry.isFile()) return "file";
    return "other";
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
