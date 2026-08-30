import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  AttachmentQueryError,
  type AttachmentRecord,
  createAttachmentStore,
  type FinalizeAttachmentInput,
  type PublicAttachment,
  toPublicAttachment,
} from "../src/attachments/store";
import type { Database } from "../src/db/client";

type CapturedQuery = { params: unknown[]; sql: string };

class FakeDatabase {
  readonly captured: CapturedQuery[] = [];
  readonly results: unknown[][] = [];
  transactions = 0;
  private readonly dialect = new PgDialect();

  execute<T>(query: SQL): Promise<T[]> {
    const compiled = this.dialect.sqlToQuery(query);
    this.captured.push({
      params: compiled.params,
      sql: compiled.sql.replaceAll(/\s+/g, " ").trim().toLowerCase(),
    });
    return Promise.resolve((this.results.shift() ?? []) as T[]);
  }

  async transaction<T>(work: (transaction: FakeDatabase) => Promise<T>) {
    this.transactions += 1;
    return work(this);
  }
}

const storageKey = "20000000-0000-4000-8000-000000000001";
const leaseToken = "30000000-0000-4000-8000-000000000001";
const reservation = {
  storageKey,
  leaseToken,
  leaseExpiresAt: new Date("2026-08-30T10:05:00.000Z"),
};
const first: AttachmentRecord = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerUserId: "user-a",
  channelId: "channel-a",
  messageId: "message-a",
  name: "report.pdf",
  mimeType: "application/pdf",
  size: 12,
  sha256: "a".repeat(64),
  storageKey,
  source: "user_upload",
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
};
const second: AttachmentRecord = {
  ...first,
  id: "10000000-0000-4000-8000-000000000002",
  storageKey: "20000000-0000-4000-8000-000000000002",
  createdAt: new Date("2026-08-30T09:00:00.000Z"),
};
const third: AttachmentRecord = {
  ...first,
  id: "10000000-0000-4000-8000-000000000003",
  storageKey: "20000000-0000-4000-8000-000000000003",
  createdAt: new Date("2026-08-30T08:00:00.000Z"),
};

function fakeStore() {
  const database = new FakeDatabase();
  return {
    database,
    store: createAttachmentStore(database as unknown as Database),
  };
}

function expectMembershipAndActiveChannel(
  query: CapturedQuery,
  actorUserId: string,
  channelId: string,
) {
  expect(query.sql).toContain("channel_memberships");
  expect(query.sql).toContain("channels");
  expect(query.sql).toMatch(/deleted_at[^)]*is null/);
  expect(query.params).toContain(actorUserId);
  expect(query.params).toContain(channelId);
}

describe("reserved attachment metadata protocol", () => {
  test("exposes only the guarded state-machine API and public DTOs hide authority fields", () => {
    const { store } = fakeStore();
    expect(Object.keys(store).toSorted()).toEqual([
      "cancel",
      "delete",
      "get",
      "list",
      "reserve",
      "withUploadingLease",
    ]);
    expect("getById" in store).toBe(false);

    expect(toPublicAttachment(first)).toEqual({
      id: first.id,
      channelId: first.channelId,
      messageId: first.messageId,
      name: first.name,
      mimeType: first.mimeType,
      size: first.size,
      sha256: first.sha256,
      source: first.source,
      createdAt: first.createdAt,
    });
    type PublicLeak = Extract<
      keyof PublicAttachment,
      "ownerUserId" | "storageKey"
    >;
    const publicTypeHasNoInternalKey: PublicLeak extends never ? true : false =
      true;
    expect(publicTypeHasNoInternalKey).toBe(true);
  });

  test("reserves an uploading row only after proving actor membership and active channel", async () => {
    const { database, store } = fakeStore();
    database.results.push([
      {
        ...reservation,
        leaseExpiresAt: reservation.leaseExpiresAt.toISOString(),
      },
    ]);

    expect(await store.reserve("user-a", "channel-a")).toEqual(reservation);
    const query = database.captured[0];
    expect(query?.sql).toMatch(/^insert into "attachment_blobs"/);
    expect(query?.sql).toContain("uploading");
    expect(query?.sql).toContain("lease_token");
    expect(query?.sql).toContain("lease_expires_at");
    if (query) expectMembershipAndActiveChannel(query, "user-a", "channel-a");

    database.results.push([]);
    expect(await store.reserve("user-b", "channel-a")).toBeNull();
  });

  test("locks and revalidates the exact uploading lease before exposing finalization", async () => {
    type AuthorityLeak = Extract<
      keyof FinalizeAttachmentInput,
      "ownerUserId" | "source" | "storageKey" | "leaseToken"
    >;
    const inputHasNoAuthorityFields: AuthorityLeak extends never
      ? true
      : false = true;
    expect(inputHasNoAuthorityFields).toBe(true);
    const input: FinalizeAttachmentInput = {
      messageId: first.messageId,
      name: first.name,
      mimeType: first.mimeType,
      size: first.size,
      sha256: first.sha256,
    };
    const { database, store } = fakeStore();
    database.results.push(
      [
        {
          storageKey,
          leaseExpiresAt: reservation.leaseExpiresAt.toISOString(),
        },
      ],
      [first],
      [{ storageKey }],
    );

    let invoked = 0;
    expect(
      await store.withUploadingLease(
        "user-a",
        "channel-a",
        reservation,
        async (lease) => {
          invoked += 1;
          expect(lease.expiresAt).toEqual(reservation.leaseExpiresAt);
          expect(await lease.finalize("user_upload", input)).toEqual(first);
          expect(await lease.markLive()).toBe(true);
          return "finished";
        },
      ),
    ).toEqual({ acquired: true, value: "finished" });
    expect(invoked).toBe(1);
    expect(database.transactions).toBe(1);
    const locked = database.captured[0];
    expect(locked?.sql).toMatch(/^select .* from "attachment_blobs"/);
    expect(locked?.sql).toContain("for update");
    expect(locked?.sql).toContain("\"state\" = 'uploading'");
    expect(locked?.sql).toContain('"lease_token" = $');
    expect(locked?.sql).toContain('"lease_expires_at" > now()');
    if (locked) expectMembershipAndActiveChannel(locked, "user-a", "channel-a");

    const finalized = database.captured[1];
    expect(finalized?.sql).toMatch(
      /^with "transitioned" as \( update "attachment_blobs"/,
    );
    expect(finalized?.sql).toContain("\"state\" = 'publishing'");
    expect(finalized?.params).toContain(storageKey);
    expect(finalized?.params).toContain(leaseToken);

    const live = database.captured[2];
    expect(live?.sql).toMatch(/^update "attachment_blobs"/);
    expect(live?.sql).toContain("\"state\" = 'live'");
    expect(live?.sql).toContain("\"state\" = 'publishing'");
    expect(live?.sql).toContain("lease_token");
    expect(live?.sql).toContain('"lease_expires_at" > now()');
    expect(live?.sql).toContain('"lease_token" = null');
  });

  test("does not invoke upload work when lease revalidation fails, and cancel is exact-token fenced", async () => {
    const { database, store } = fakeStore();
    database.results.push([]);
    let invoked = 0;

    expect(
      await store.withUploadingLease(
        "user-a",
        "channel-a",
        reservation,
        async () => {
          invoked += 1;
          return "unsafe";
        },
      ),
    ).toEqual({ acquired: false });
    expect(invoked).toBe(0);

    database.results.push([{ storageKey }]);
    expect(await store.cancel("user-a", "channel-a", reservation)).toBe(true);
    const cancelled = database.captured[1];
    expect(cancelled?.sql).toContain("\"state\" = 'deleting'");
    expect(cancelled?.sql).toContain("\"state\" = 'uploading'");
    expect(cancelled?.sql).toContain('"next_attempt_at" = now()');
    expect(cancelled?.params).toContain(leaseToken);
  });

  test("get and list expose only live inventory rows with owner/channel authorization", async () => {
    const { database, store } = fakeStore();
    database.results.push([first], [first, second, third]);

    expect(await store.get("user-a", "channel-a", first.id)).toEqual(first);
    const get = database.captured[0];
    expect(get?.sql).toContain('inner join "attachment_blobs"');
    expect(get?.sql).toContain("\"state\" = 'live'");
    if (get) expectMembershipAndActiveChannel(get, "user-a", "channel-a");

    const page = await store.list("user-a", "channel-a", {
      limit: 2,
      messageId: "message-a",
    });
    expect(page.attachments).toEqual([first, second]);
    expect(page.nextCursor).toBeString();
    const list = database.captured[1];
    expect(list?.sql).toContain('inner join "attachment_blobs"');
    expect(list?.sql).toContain("\"state\" = 'live'");
    expect(list?.params).toContain(3);
  });

  test("atomically removes metadata and transitions its live inventory row to deleting", async () => {
    const { database, store } = fakeStore();
    database.results.push([{ deleted: true }]);

    expect(await store.delete("user-a", "channel-a", first.id)).toBe(true);
    const query = database.captured[0];
    expect(query?.sql).toMatch(/^with "target" as \(/);
    expect(query?.sql).toContain('update "attachment_blobs"');
    expect(query?.sql).toContain("\"state\" = 'deleting'");
    expect(query?.sql).toContain("\"state\" = 'live'");
    expect(query?.sql).toContain('delete from "attachments"');
    expect(query?.sql).toContain('"next_attempt_at" = now()');
    if (query) expectMembershipAndActiveChannel(query, "user-a", "channel-a");
  });

  test("malformed ids, storage keys and lease tokens fail closed before SQL", async () => {
    const { database, store } = fakeStore();
    expect(await store.get("user-a", "channel-a", "not-a-uuid")).toBeNull();
    expect(await store.delete("user-a", "channel-a", "../attachment")).toBe(
      false,
    );
    expect(database.captured).toEqual([]);
  });

  test("rejects malformed pagination before SQL and bounds page sizes", async () => {
    const { database, store } = fakeStore();
    const listing = store.list("user-a", "channel-a", {
      cursor: "not-a-page-cursor",
    });
    await expect(listing).rejects.toBeInstanceOf(AttachmentQueryError);
    expect(database.captured).toEqual([]);

    database.results.push([]);
    await store.list("user-a", "channel-a", { limit: 500 });
    expect(database.captured[0]?.params).toContain(101);
  });
});
