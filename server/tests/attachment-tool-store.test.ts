import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AttachmentBlobStore } from "../src/attachments/blob-store";
import type {
  AttachmentPage,
  AttachmentRecord,
  AttachmentStore,
} from "../src/attachments/store";
import {
  createConversationAttachmentToolStore,
  type TrustedAttachmentToolContext,
} from "../src/attachments/tool-store";
import type { Database } from "../src/db/client";

type CapturedQuery = { params: unknown[]; sql: string };

class FakeDatabase {
  readonly captured: CapturedQuery[] = [];
  readonly results: unknown[][] = [];
  private readonly dialect = new PgDialect();

  execute<T>(query: SQL): Promise<T[]> {
    const compiled = this.dialect.sqlToQuery(query);
    this.captured.push({
      params: compiled.params,
      sql: compiled.sql.replaceAll(/\s+/g, " ").trim().toLowerCase(),
    });
    return Promise.resolve((this.results.shift() ?? []) as T[]);
  }
}

const context: TrustedAttachmentToolContext = {
  actorId: "user-a",
  botId: "bot-a",
  threadId: "thread-a",
};

const attachment: AttachmentRecord = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerUserId: "user-a",
  channelId: "channel-a",
  messageId: "message-a",
  name: "notes.txt",
  mimeType: "text/plain",
  size: 12,
  sha256: "a".repeat(64),
  storageKey: "20000000-0000-4000-8000-000000000001",
  source: "user_upload",
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
};

function fakeDependencies() {
  const database = new FakeDatabase();
  const calls: Array<{
    actorUserId: string;
    channelId: string;
    limit?: number;
  }> = [];
  const metadata: Pick<AttachmentStore, "get" | "list"> = {
    async get(actorUserId, channelId, attachmentId) {
      calls.push({ actorUserId, channelId });
      return attachmentId === attachment.id ? attachment : null;
    },
    async list(actorUserId, channelId, query): Promise<AttachmentPage> {
      calls.push({ actorUserId, channelId, limit: query?.limit });
      return { attachments: [attachment], nextCursor: "next-page" };
    },
  };
  const blobs: Pick<AttachmentBlobStore, "open"> = {
    async open() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      });
    },
  };
  return { blobs, calls, database, metadata };
}

describe("conversation attachment tool authorization", () => {
  test("derives the channel only from trusted actor, bot and thread context", async () => {
    const { blobs, calls, database, metadata } = fakeDependencies();
    database.results.push([{ channelId: "channel-a" }]);
    const store = createConversationAttachmentToolStore({
      blobs,
      database: database as unknown as Database,
      metadata,
    });

    const page = await store.list(context, { limit: 500 });

    expect(page?.attachments).toEqual([
      {
        id: attachment.id,
        messageId: attachment.messageId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        source: attachment.source,
        createdAt: attachment.createdAt.toISOString(),
      },
    ]);
    expect(page?.nextCursor).toBe("next-page");
    expect(calls).toEqual([
      { actorUserId: "user-a", channelId: "channel-a", limit: 50 },
    ]);

    const authority = database.captured[0];
    expect(authority?.sql).toContain("intelligence_channel_mappings");
    expect(authority?.sql).toContain("channel_memberships");
    expect(authority?.sql).toContain("channel_agents");
    expect(authority?.sql).toContain("channels");
    expect(authority?.sql).toMatch(/deleted_at[^)]*is null/);
    expect(authority?.params).toContain("user-a");
    expect(authority?.params).toContain("bot-a");
    expect(authority?.params).toContain("thread-a");

    const serialized = JSON.stringify(page);
    for (const forbidden of [
      "ownerUserId",
      "storageKey",
      "sha256",
      attachment.storageKey,
      attachment.sha256,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("fails closed before metadata access when any trusted binding is absent", async () => {
    const { blobs, calls, database, metadata } = fakeDependencies();
    database.results.push([], [], []);
    const store = createConversationAttachmentToolStore({
      blobs,
      database: database as unknown as Database,
      metadata,
    });

    expect(await store.list(context)).toBeNull();
    expect(await store.metadata(context, attachment.id)).toBeNull();
    expect(await store.textSource(context, attachment.id)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("returns a safe stream capability without exposing storage authority", async () => {
    const { blobs, database, metadata } = fakeDependencies();
    database.results.push([{ channelId: "channel-a" }]);
    const store = createConversationAttachmentToolStore({
      blobs,
      database: database as unknown as Database,
      metadata,
    });

    const source = await store.textSource(context, attachment.id);

    expect(source?.attachment.name).toBe("notes.txt");
    expect(Object.keys(source ?? {}).toSorted()).toEqual([
      "attachment",
      "openStream",
    ]);
    expect(JSON.stringify(source)).not.toContain(attachment.storageKey);
    const reader = (await source?.openStream())?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
      "hello",
    );
    await reader?.cancel();
  });

  test("offers the same authorized content stream to the internal model boundary", async () => {
    const { blobs, database, metadata } = fakeDependencies();
    database.results.push([{ channelId: "channel-a" }]);
    const store = createConversationAttachmentToolStore({
      blobs,
      database: database as unknown as Database,
      metadata,
    });

    const source = await store.contentSource(context, attachment.id);

    expect(Object.keys(source ?? {}).toSorted()).toEqual([
      "attachment",
      "openStream",
    ]);
    expect(JSON.stringify(source)).not.toContain(attachment.storageKey);
    expect(source?.attachment.id).toBe(attachment.id);
  });

  test("cancels a blob that opens after its read signal was aborted", async () => {
    const { database, metadata } = fakeDependencies();
    database.results.push([{ channelId: "channel-a" }]);
    let resolveOpen: ((stream: ReadableStream<Uint8Array>) => void) | null =
      null;
    const delayedOpen = new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveOpen = resolve;
    });
    let cancelled = 0;
    const store = createConversationAttachmentToolStore({
      database: database as unknown as Database,
      metadata,
      blobs: { open: async () => delayedOpen },
    });
    const source = await store.textSource(context, attachment.id);
    if (!source) throw new Error("expected authorized text source");
    const controller = new AbortController();

    const opened = source.openStream(controller.signal);
    controller.abort(new Error("read deadline"));
    resolveOpen?.(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1;
        },
      }),
    );

    await expect(opened).rejects.toThrow("read deadline");
    expect(cancelled).toBe(1);
  });

  test("rejects malformed trusted context without issuing SQL", async () => {
    const { blobs, calls, database, metadata } = fakeDependencies();
    const store = createConversationAttachmentToolStore({
      blobs,
      database: database as unknown as Database,
      metadata,
    });

    expect(await store.list({ ...context, threadId: "" })).toBeNull();
    expect(
      await store.metadata(
        { ...context, botId: "x".repeat(256) },
        attachment.id,
      ),
    ).toBeNull();
    expect(database.captured).toEqual([]);
    expect(calls).toEqual([]);
  });
});
