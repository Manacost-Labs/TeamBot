import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentBlobStore } from "../src/attachments/blob-store";

const cleanupRoots: string[] = [];

async function freshRoot(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "teambot-attachments-"));
  cleanupRoots.push(parent);
  return { parent, root: join(parent, "blobs") };
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function writeTemporary(
  store: AttachmentBlobStore,
  storageKey: string,
  source: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal },
) {
  return store.withKey(storageKey, (blob) =>
    blob.writeTemporary(source, options),
  );
}

function inspect(store: AttachmentBlobStore, storageKey: string) {
  return store.withKey(storageKey, (blob) => blob.inspect());
}

function publish(store: AttachmentBlobStore, storageKey: string) {
  return store.withKey(storageKey, (blob) => blob.publish());
}

function deleteBlob(store: AttachmentBlobStore, storageKey: string) {
  return store.withKey(storageKey, (blob) => blob.delete());
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("reserved filesystem attachment blobs", () => {
  test("does not expose unfenced namespace mutations on the public store type", () => {
    type UnsafeMutation = Extract<
      keyof AttachmentBlobStore,
      "delete" | "inspect" | "publish" | "withKey" | "writeTemporary"
    >;
    const hasNoUnsafeMutation: UnsafeMutation extends never ? true : false =
      true;
    expect(hasNoUnsafeMutation).toBe(true);
  });

  test("syncs file contents and the root directory after every namespace transition", async () => {
    const { root } = await freshRoot();
    const events: string[] = [];
    const store = new AttachmentBlobStore({
      root,
      durability: {
        syncFile: async (handle) => {
          events.push("file");
          await handle.sync();
        },
        syncDirectory: async () => {
          events.push("directory");
        },
      },
    });
    const storageKey = randomUUID();

    await writeTemporary(
      store,
      storageKey,
      byteStream(new TextEncoder().encode("durable")),
    );
    expect(events).toEqual(["directory", "file"]);
    await publish(store, storageKey);
    expect(events).toEqual(["directory", "file", "directory"]);
    await deleteBlob(store, storageKey);
    expect(events).toEqual(["directory", "file", "directory", "directory"]);
  });

  test("writes exact bytes only to the reservation's deterministic private temporary path", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const storageKey = randomUUID();
    const first = new TextEncoder().encode("first chunk\n");
    const second = new Uint8Array([0, 1, 2, 255, 128]);
    const expected = new Uint8Array(first.byteLength + second.byteLength);
    expected.set(first);
    expected.set(second, first.byteLength);

    const stored = await writeTemporary(
      store,
      storageKey,
      byteStream(first, second),
    );

    expect(stored).toEqual({
      storageKey,
      size: expected.byteLength,
      sha256: createHash("sha256").update(expected).digest("hex"),
    });
    expect(await readdir(root)).toEqual([`.tmp-${storageKey}`]);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, `.tmp-${storageKey}`))).mode & 0o777).toBe(
      0o600,
    );
    expect(await inspect(store, storageKey)).toEqual({
      temporary: true,
      live: false,
    });
    await expect(store.open(storageKey)).rejects.toThrow(/not found/i);
  });

  test("publishes by idempotent rename and opens only the live path", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const storageKey = randomUUID();
    const bytes = new TextEncoder().encode("publish me");
    await writeTemporary(store, storageKey, byteStream(bytes));

    expect(await publish(store, storageKey)).toBe(true);
    expect(await publish(store, storageKey)).toBe(false);
    expect(await inspect(store, storageKey)).toEqual({
      temporary: false,
      live: true,
    });
    expect(await readdir(root)).toEqual([storageKey]);
    expect(
      new Uint8Array(
        await new Response(await store.open(storageKey)).arrayBuffer(),
      ),
    ).toEqual(bytes);
  });

  test("fences concurrent publishers at the same deterministic rename", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const storageKey = randomUUID();
    const bytes = new TextEncoder().encode("publish once");
    await writeTemporary(store, storageKey, byteStream(bytes));

    const results = await Promise.all([
      publish(store, storageKey),
      publish(store, storageKey),
    ]);

    expect(results.toSorted()).toEqual([false, true]);
    expect(await inspect(store, storageKey)).toEqual({
      temporary: false,
      live: true,
    });
    expect(
      new Uint8Array(
        await new Response(await store.open(storageKey)).arrayBuffer(),
      ),
    ).toEqual(bytes);
  });

  test("rejects bytes beyond the configured limit and removes the deterministic temporary file", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root, maxBytes: 5 });
    const storageKey = randomUUID();

    await expect(
      writeTemporary(
        store,
        storageKey,
        byteStream(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
      ),
    ).rejects.toThrow(/5 bytes/i);

    expect(await readdir(root)).toEqual([]);
  });

  test("defaults to a 25 MiB streaming limit without buffering the upload as one value", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const oneMiB = new Uint8Array(1024 * 1024);
    let chunks = 26;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks-- > 0) {
          controller.enqueue(oneMiB);
          return;
        }
        controller.close();
      },
    });

    await expect(
      writeTemporary(store, randomUUID(), oversized),
    ).rejects.toThrow(/26214400 bytes/);
    expect(await readdir(root)).toEqual([]);
  });

  test("rejects an empty or failed upload without leaving its tracked temporary file", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });

    await expect(
      writeTemporary(store, randomUUID(), byteStream()),
    ).rejects.toThrow(/empty/i);

    let pulls = 0;
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          return;
        }
        controller.error(new Error("upload interrupted"));
      },
    });
    await expect(
      writeTemporary(store, randomUUID(), interrupted),
    ).rejects.toThrow("upload interrupted");
    expect(await readdir(root)).toEqual([]);
  });

  test("aborts a stalled stream and removes its temporary file", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const controller = new AbortController();
    const stalled = deferred();
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (!sent) {
          sent = true;
          streamController.enqueue(new Uint8Array([1, 2, 3]));
          return;
        }
        return stalled.promise;
      },
    });
    const writing = writeTemporary(store, randomUUID(), stream, {
      signal: controller.signal,
    });
    while ((await readdir(root).catch(() => [])).length === 0) {
      await Promise.resolve();
    }

    controller.abort(new Error("upload cancelled"));

    await expect(writing).rejects.toThrow("upload cancelled");
    expect(await readdir(root)).toEqual([]);
    stalled.resolve();
  });

  test("rejects invalid keys and traversal before touching paths outside the root", async () => {
    const { parent, root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "keep me");

    for (const key of ["../outside.txt", "/etc/passwd", "not-a-uuid", ""]) {
      await expect(
        writeTemporary(store, key, byteStream(new Uint8Array([1]))),
      ).rejects.toThrow(/invalid.*storage key/i);
      await expect(inspect(store, key)).rejects.toThrow(
        /invalid.*storage key/i,
      );
      await expect(publish(store, key)).rejects.toThrow(
        /invalid.*storage key/i,
      );
      await expect(store.open(key)).rejects.toThrow(/invalid.*storage key/i);
      await expect(deleteBlob(store, key)).rejects.toThrow(
        /invalid.*storage key/i,
      );
    }

    expect(await readFile(outside, "utf8")).toBe("keep me");
  });

  test("rejects a symlink root instead of writing through it", async () => {
    const { parent, root } = await freshRoot();
    const outside = join(parent, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, root, "dir");
    const store = new AttachmentBlobStore({ root });

    await expect(
      writeTemporary(
        store,
        randomUUID(),
        byteStream(new Uint8Array([1, 2, 3])),
      ),
    ).rejects.toThrow(/symbolic link/i);
    expect(await readdir(outside)).toEqual([]);
  });

  test("inspect, publish and delete fail closed on symlinks without touching their targets", async () => {
    const { parent, root } = await freshRoot();
    await mkdir(root, { mode: 0o700 });
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "private outside bytes", { mode: 0o600 });
    const key = randomUUID();
    await symlink(outside, join(root, `.tmp-${key}`), "file");
    const store = new AttachmentBlobStore({ root });

    await expect(inspect(store, key)).rejects.toThrow(/symbolic link/i);
    await expect(publish(store, key)).rejects.toThrow(/symbolic link/i);
    await expect(deleteBlob(store, key)).rejects.toThrow(/symbolic link/i);
    expect(await readFile(outside, "utf8")).toBe("private outside bytes");
    expect((await lstat(join(root, `.tmp-${key}`))).isSymbolicLink()).toBe(
      true,
    );
  });

  test("deletes both temporary and live representations idempotently", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const temporaryKey = randomUUID();
    const liveKey = randomUUID();
    await writeTemporary(
      store,
      temporaryKey,
      byteStream(new TextEncoder().encode("temporary")),
    );
    await writeTemporary(
      store,
      liveKey,
      byteStream(new TextEncoder().encode("live")),
    );
    await publish(store, liveKey);

    expect(await deleteBlob(store, temporaryKey)).toBe(true);
    expect(await deleteBlob(store, liveKey)).toBe(true);
    expect(await deleteBlob(store, liveKey)).toBe(false);
    expect(await inspect(store, temporaryKey)).toEqual({
      temporary: false,
      live: false,
    });
    expect(await inspect(store, liveKey)).toEqual({
      temporary: false,
      live: false,
    });
    expect(await readdir(root)).toEqual([]);
  });
});
