import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  artifactAttachmentMessageId,
  createArtifactExportStore,
} from "../src/artifacts/export-store";
import type { Database } from "../src/db/client";

class FakeDatabase {
  readonly captured: Array<{ sql: string; params: unknown[] }> = [];
  readonly results: unknown[][] = [];
  private readonly dialect = new PgDialect();

  execute<T>(query: SQL): Promise<T[]> {
    const compiled = this.dialect.sqlToQuery(query);
    this.captured.push({
      sql: compiled.sql.replaceAll(/\s+/g, " ").trim().toLowerCase(),
      params: compiled.params,
    });
    return Promise.resolve((this.results.shift() ?? []) as T[]);
  }
}

const context = {
  ownerUserId: "user-a",
  channelId: "channel-a",
  botId: "bot-a",
  runId: "run-a",
  fingerprint: "a".repeat(64),
};
const exportId = "10000000-0000-4000-8000-000000000001";
const attachmentId = "20000000-0000-4000-8000-000000000002";

describe("artifact export idempotency store", () => {
  test("claims a new or recoverable request with one database-clock lease", async () => {
    const database = new FakeDatabase();
    database.results.push([
      { id: exportId, state: "creating", attachmentId: null },
    ]);
    const store = createArtifactExportStore(database as unknown as Database);

    const claimed = await store.claim(context, 30_000);

    expect(claimed).toEqual({
      kind: "claimed",
      exportId,
      leaseToken: expect.any(String),
      messageId: `artifact:${exportId}`,
    });
    const query = database.captured[0];
    expect(query?.sql).toContain("on conflict");
    expect(query?.sql).toContain("\"state\" = 'failed'");
    expect(query?.sql).toContain('"lease_expires_at" <= now()');
    expect(query?.sql).toContain("interval '1 millisecond'");
    expect(query?.params).toContain(context.fingerprint);
    expect(query?.params).not.toContain("artifact content");
  });

  test("returns the canonical ready attachment after a conflict", async () => {
    const database = new FakeDatabase();
    database.results.push([], [{ id: exportId, state: "ready", attachmentId }]);
    const store = createArtifactExportStore(database as unknown as Database);

    expect(await store.claim(context)).toEqual({
      kind: "ready",
      exportId,
      attachmentId,
    });
    expect(database.captured).toHaveLength(2);
  });

  test("does not steal a live creation lease", async () => {
    const database = new FakeDatabase();
    database.results.push(
      [],
      [{ id: exportId, state: "creating", attachmentId: null }],
    );
    const store = createArtifactExportStore(database as unknown as Database);

    expect(await store.claim(context)).toEqual({ kind: "busy" });
  });

  test("completes and fails only the matching lease token", async () => {
    const database = new FakeDatabase();
    database.results.push(
      [{ id: exportId }],
      [{ id: exportId }],
      [{ id: exportId }],
    );
    const store = createArtifactExportStore(database as unknown as Database);
    const leaseToken = "30000000-0000-4000-8000-000000000003";

    expect(await store.complete(exportId, leaseToken, attachmentId)).toBe(true);
    expect(await store.fail(exportId, leaseToken)).toBe(true);
    expect(await store.invalidateReady(exportId, attachmentId)).toBe(true);
    expect(database.captured[0]?.sql).toContain('"lease_expires_at" > now()');
    expect(database.captured[1]?.sql).toContain("\"state\" = 'failed'");
    expect(database.captured[2]?.sql).toContain("\"state\" = 'ready'");
  });

  test("rejects malformed trusted identity before issuing SQL", async () => {
    const database = new FakeDatabase();
    const store = createArtifactExportStore(database as unknown as Database);

    await expect(
      store.claim({ ...context, fingerprint: "not-a-sha" }),
    ).rejects.toThrow("Invalid artifact export identity");
    expect(await store.complete("bad", "bad", "bad")).toBe(false);
    expect(await store.fail("bad", "bad")).toBe(false);
    expect(await store.invalidateReady("bad", "bad")).toBe(false);
    expect(database.captured).toEqual([]);
  });

  test("uses a bounded opaque attachment message id", () => {
    expect(artifactAttachmentMessageId(exportId)).toBe(`artifact:${exportId}`);
    expect(() => artifactAttachmentMessageId("../../private")).toThrow(
      "Invalid artifact export id",
    );
  });
});
