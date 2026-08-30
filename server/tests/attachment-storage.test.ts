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

describe("filesystem attachment blob store", () => {
  test("streams exact bytes, reports their real hash and size, and uses private opaque paths", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const first = new TextEncoder().encode("first chunk\n");
    const second = new Uint8Array([0, 1, 2, 255, 128]);
    const expected = new Uint8Array(first.byteLength + second.byteLength);
    expected.set(first);
    expected.set(second, first.byteLength);

    const stored = await store.write(byteStream(first, second));

    expect(stored.size).toBe(expected.byteLength);
    expect(stored.sha256).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );
    expect(stored.storageKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(stored.storageKey).not.toContain(stored.sha256);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, stored.storageKey))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readdir(root)).toEqual([stored.storageKey]);
    expect(
      new Uint8Array(
        await new Response(await store.open(stored.storageKey)).arrayBuffer(),
      ),
    ).toEqual(expected);
    expect(
      new Uint8Array(await readFile(join(root, stored.storageKey))),
    ).toEqual(expected);
  });

  test("rejects bytes beyond the configured limit and removes the private temporary file", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root, maxBytes: 5 });

    await expect(
      store.write(
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

    await expect(store.write(oversized)).rejects.toThrow(/26214400 bytes/);

    expect(await readdir(root)).toEqual([]);
  });

  test("rejects an empty upload before publishing a blob", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });

    await expect(store.write(byteStream())).rejects.toThrow(/empty/i);

    expect(await readdir(root)).toEqual([]);
  });

  test("removes the temporary file when the incoming stream fails", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
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

    await expect(store.write(interrupted)).rejects.toThrow(
      "upload interrupted",
    );

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
    const writing = store.write(stream, { signal: controller.signal });
    while ((await readdir(root).catch(() => [])).length === 0) {
      await Promise.resolve();
    }

    controller.abort(new Error("upload cancelled"));

    await expect(writing).rejects.toThrow("upload cancelled");
    expect(await readdir(root)).toEqual([]);
    stalled.resolve();
  });

  test("rejects invalid keys and traversal before reading or deleting outside the root", async () => {
    const { parent, root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "keep me");

    for (const key of ["../outside.txt", "/etc/passwd", "not-a-uuid", ""]) {
      await expect(store.open(key)).rejects.toThrow(/invalid.*storage key/i);
      await expect(store.delete(key)).rejects.toThrow(/invalid.*storage key/i);
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
      store.write(byteStream(new Uint8Array([1, 2, 3]))),
    ).rejects.toThrow(/symbolic link/i);

    expect(await readdir(outside)).toEqual([]);
  });

  test("rejects target symlinks for both open and delete without touching the target", async () => {
    const { parent, root } = await freshRoot();
    await mkdir(root, { mode: 0o700 });
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "private outside bytes", { mode: 0o600 });
    const key = randomUUID();
    await symlink(outside, join(root, key), "file");
    const store = new AttachmentBlobStore({ root });

    await expect(store.open(key)).rejects.toThrow(/symbolic link/i);
    await expect(store.delete(key)).rejects.toThrow(/symbolic link/i);

    expect(await readFile(outside, "utf8")).toBe("private outside bytes");
    expect((await lstat(join(root, key))).isSymbolicLink()).toBe(true);
  });

  test("deletes a stored blob without following missing or replaced paths", async () => {
    const { root } = await freshRoot();
    const store = new AttachmentBlobStore({ root });
    const stored = await store.write(
      byteStream(new TextEncoder().encode("delete me")),
    );

    expect(await store.delete(stored.storageKey)).toBe(true);
    expect(await store.delete(stored.storageKey)).toBe(false);
    await expect(store.open(stored.storageKey)).rejects.toThrow(/not found/i);
    expect(await readdir(root)).toEqual([]);
  });
});
