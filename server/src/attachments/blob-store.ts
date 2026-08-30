import { createHash, randomUUID } from "node:crypto";
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
};

type WriteOptions = {
  signal?: AbortSignal;
};

/** A streaming, private filesystem store for attachment bytes. */
export class AttachmentBlobStore {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor({
    root,
    maxBytes = DEFAULT_MAX_BYTES,
  }: AttachmentBlobStoreOptions) {
    if (!root.trim()) throw new Error("Attachment storage root is required");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Attachment maxBytes must be a positive safe integer");
    }
    this.root = resolve(root);
    this.maxBytes = maxBytes;
  }

  async write(
    source: ReadableStream<Uint8Array>,
    options: WriteOptions = {},
  ): Promise<StoredAttachmentBlob> {
    options.signal?.throwIfAborted();
    await this.ensurePrivateRoot();

    const storageKey = randomUUID();
    const targetPath = this.pathFor(storageKey);
    const temporaryPath = join(this.root, `.tmp-${randomUUID()}`);
    const reader = source.getReader();
    const hash = createHash("sha256");
    let size = 0;
    let handle: FileHandle | null = null;
    let temporaryExists = false;
    let completed = false;

    try {
      if (await pathKind(targetPath)) {
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
      await handle.close();
      handle = null;

      // Recheck the root immediately before publishing. The rename is the only point at which a
      // reader can observe this key, so partial uploads never become addressable blobs.
      await this.ensurePrivateRoot();
      options.signal?.throwIfAborted();
      await rename(temporaryPath, targetPath);
      temporaryExists = false;
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
      if (temporaryExists) {
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!hasCode(error, "ENOENT")) throw error;
        });
      }
    }
  }

  async open(storageKey: string): Promise<ReadableStream<Uint8Array>> {
    this.assertStorageKey(storageKey);
    await this.ensurePrivateRoot();
    const targetPath = this.pathFor(storageKey);
    const kind = await pathKind(targetPath);
    if (kind === null) throw new Error("Attachment blob not found");
    if (kind === "symlink") {
      throw new Error("Attachment blob cannot be a symbolic link");
    }
    if (kind !== "file") throw new Error("Attachment blob is not a file");

    let handle: FileHandle | null = null;
    try {
      handle = await openFile(
        targetPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error("Attachment blob is not a file");
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
        throw new Error("Attachment blob cannot be a symbolic link", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async delete(storageKey: string): Promise<boolean> {
    this.assertStorageKey(storageKey);
    await this.ensurePrivateRoot();
    const targetPath = this.pathFor(storageKey);
    const kind = await pathKind(targetPath);
    if (kind === null) return false;
    if (kind === "symlink") {
      throw new Error("Attachment blob cannot be a symbolic link");
    }
    if (kind !== "file") throw new Error("Attachment blob is not a file");

    try {
      await unlink(targetPath);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  private assertStorageKey(storageKey: string): void {
    if (!STORAGE_KEY.test(storageKey)) {
      throw new Error("Invalid attachment storage key");
    }
  }

  private pathFor(storageKey: string): string {
    return join(this.root, storageKey);
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
