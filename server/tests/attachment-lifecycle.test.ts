import { describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createAttachmentBlobMaintenance } from "../src/attachments/blob-store";
import {
  type AttachmentLifecycleClaim,
  type AttachmentLifecycleStore,
  createAttachmentLifecycleStore,
  processAttachmentBlobLifecycle,
} from "../src/attachments/lifecycle";
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

const firstKey = "20000000-0000-4000-8000-000000000001";
const secondKey = "20000000-0000-4000-8000-000000000002";
const firstToken = "30000000-0000-4000-8000-000000000001";
const secondToken = "30000000-0000-4000-8000-000000000002";

function claim(
  storageKey: string,
  claimToken: string,
  state: AttachmentLifecycleClaim["state"],
  attempts = 0,
): AttachmentLifecycleClaim {
  return { storageKey, claimToken, state, attempts };
}

describe("leased attachment lifecycle database store", () => {
  test("claims a bounded due batch with row locks, expired-lease recovery and per-row tokens", async () => {
    const database = new FakeDatabase();
    database.results.push([
      {
        storageKey: firstKey,
        claimToken: firstToken,
        state: "uploading",
        attempts: 2,
      },
    ]);
    const store = createAttachmentLifecycleStore(
      database as unknown as Database,
    );

    expect(await store.claimDue(500, 30_000)).toEqual([
      claim(firstKey, firstToken, "uploading", 2),
    ]);
    const query = database.captured[0];
    expect(query?.sql).toMatch(/^with "candidates" as \( select/);
    expect(query?.sql).toContain('from "attachment_blobs"');
    expect(query?.sql).toContain("for update skip locked");
    expect(query?.sql).toContain('"next_attempt_at" <= now()');
    expect(query?.sql).toContain('"lease_expires_at" <= now()');
    expect(query?.sql).toContain('"lease_token" is null');
    expect(query?.sql).toContain("gen_random_uuid()");
    expect(query?.sql).toMatch(
      /order by .*next_attempt_at.*attempts.*storage_key/,
    );
    expect(query?.params).toContain(100);
    expect(query?.params).toContain(30_000);
  });

  test("fences publish completion and deletion acknowledgement by exact claim token and state", async () => {
    const database = new FakeDatabase();
    database.results.push(
      [{ storageKey: firstKey }],
      [{ storageKey: firstKey }],
      [{ storageKey: secondKey }],
      [{ storageKey: secondKey }],
    );
    const store = createAttachmentLifecycleStore(
      database as unknown as Database,
    );

    expect(
      await store.withClaim(
        claim(firstKey, firstToken, "publishing"),
        (lease) => lease.completePublishing(),
      ),
    ).toEqual({ acquired: true, value: true });
    const publishingLock = database.captured[0];
    expect(publishingLock?.sql).toMatch(/^select .* from "attachment_blobs"/);
    expect(publishingLock?.sql).toContain("for update");
    expect(publishingLock?.sql).toContain('"lease_token" = $');
    expect(publishingLock?.sql).toContain('"lease_expires_at" > now()');
    const publishing = database.captured[1];
    expect(publishing?.sql).toMatch(/^update "attachment_blobs"/);
    expect(publishing?.sql).toContain("\"state\" = 'live'");
    expect(publishing?.sql).toContain("\"state\" = 'publishing'");
    expect(publishing?.sql).toContain('"lease_token" = $');
    expect(publishing?.sql).toContain('"lease_token" = null');
    expect(publishing?.params).toContain(firstToken);

    expect(
      await store.withClaim(
        claim(secondKey, secondToken, "deleting"),
        (lease) => lease.completeDeletion(),
      ),
    ).toEqual({ acquired: true, value: true });
    const deletionLock = database.captured[2];
    expect(deletionLock?.sql).toContain('"state" = $');
    expect(deletionLock?.params).toContain("deleting");
    const deletion = database.captured[3];
    expect(deletion?.sql).toMatch(/^delete from "attachment_blobs"/);
    expect(deletion?.sql).toContain("\"state\" in ('uploading', 'deleting')");
    expect(deletion?.sql).toContain('"lease_token" = $');
    expect(deletion?.params).toContain(secondToken);
    expect(database.transactions).toBe(2);
  });

  test("does not expose filesystem work when the claimed token changed before the row lock", async () => {
    const database = new FakeDatabase();
    database.results.push([]);
    const store = createAttachmentLifecycleStore(
      database as unknown as Database,
    );
    let invoked = 0;

    expect(
      await store.withClaim(
        claim(firstKey, firstToken, "publishing"),
        async () => {
          invoked += 1;
          return true;
        },
      ),
    ).toEqual({ acquired: false });
    expect(invoked).toBe(0);
  });

  test("failure schedules a later retry, increments attempts and releases the worker lease", async () => {
    const database = new FakeDatabase();
    database.results.push([{ storageKey: firstKey }]);
    const store = createAttachmentLifecycleStore(
      database as unknown as Database,
    );
    const nextAttemptAt = new Date("2026-08-30T10:00:08.000Z");

    expect(
      await store.releaseFailure(
        claim(firstKey, firstToken, "publishing", 3),
        nextAttemptAt,
      ),
    ).toBe(true);
    const query = database.captured[0];
    expect(query?.sql).toMatch(/^update "attachment_blobs"/);
    expect(query?.sql).toContain('"attempts" = "attempts" + 1');
    expect(query?.sql).toContain('"next_attempt_at" = $');
    expect(query?.sql).toContain('"lease_token" = null');
    expect(query?.sql).toContain('"lease_expires_at" = null');
    expect(query?.params).toContain(firstToken);
    expect(query?.params).toContain(nextAttemptAt);
  });
});

function fakeLifecycle(claims: AttachmentLifecycleClaim[]) {
  const completedPublishing: AttachmentLifecycleClaim[] = [];
  const completedDeletion: AttachmentLifecycleClaim[] = [];
  const released: Array<{
    claim: AttachmentLifecycleClaim;
    nextAttemptAt: Date;
  }> = [];
  const lifecycle: AttachmentLifecycleStore = {
    claimDue: () => Promise.resolve(claims),
    withClaim: async (item, operation) => {
      return {
        acquired: true,
        value: await operation({
          completePublishing: () => {
            completedPublishing.push(item);
            return Promise.resolve(true);
          },
          completeDeletion: () => {
            completedDeletion.push(item);
            return Promise.resolve(true);
          },
        }),
      };
    },
    releaseFailure: (item, nextAttemptAt) => {
      released.push({ claim: item, nextAttemptAt });
      return Promise.resolve(true);
    },
  };
  return { lifecycle, completedPublishing, completedDeletion, released };
}

describe("bounded attachment lifecycle processor", () => {
  test("recovers both publishing crash phases without republishing a live file", async () => {
    const temporary = claim(firstKey, firstToken, "publishing");
    const alreadyLive = claim(secondKey, secondToken, "publishing");
    const state = fakeLifecycle([temporary, alreadyLive]);
    const published: string[] = [];
    const blobs = coordinatedBlobs({
      inspect: (key) =>
        key === firstKey
          ? { temporary: true, live: false }
          : { temporary: false, live: true },
      publish: (key) => {
        published.push(key);
        return true;
      },
    });

    expect(
      await processAttachmentBlobLifecycle({
        lifecycle: state.lifecycle,
        maintenance: createAttachmentBlobMaintenance(blobs),
        limit: 2,
      }),
    ).toEqual({ claimed: 2, completed: 2, retried: 0, lost: 0 });
    expect(published).toEqual([firstKey]);
    expect(state.completedPublishing).toEqual([temporary, alreadyLive]);
  });

  test("cleans expired uploads and deleting rows from both filesystem representations", async () => {
    const uploading = claim(firstKey, firstToken, "uploading");
    const deleting = claim(secondKey, secondToken, "deleting");
    const state = fakeLifecycle([uploading, deleting]);
    const deleted: string[] = [];
    const blobs = coordinatedBlobs({
      delete: (key) => {
        deleted.push(key);
        return true;
      },
    });

    expect(
      await processAttachmentBlobLifecycle({
        lifecycle: state.lifecycle,
        maintenance: createAttachmentBlobMaintenance(blobs),
      }),
    ).toEqual({ claimed: 2, completed: 2, retried: 0, lost: 0 });
    expect(deleted).toEqual([firstKey, secondKey]);
    expect(state.completedDeletion).toEqual([uploading, deleting]);
  });

  test("backs off a poison row and continues to later claims without logging sensitive details", async () => {
    const poison = claim(firstKey, firstToken, "publishing", 3);
    const healthy = claim(secondKey, secondToken, "deleting");
    const state = fakeLifecycle([poison, healthy]);
    const now = new Date("2026-08-30T10:00:00.000Z");
    const blobs = coordinatedBlobs({
      inspect: () => ({ temporary: false, live: false }),
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(
        await processAttachmentBlobLifecycle({
          lifecycle: state.lifecycle,
          maintenance: createAttachmentBlobMaintenance(blobs),
          now: () => now,
        }),
      ).toEqual({ claimed: 2, completed: 1, retried: 1, lost: 0 });
      expect(state.released).toEqual([
        {
          claim: poison,
          nextAttemptAt: new Date("2026-08-30T10:00:08.000Z"),
        },
      ]);
      expect(state.completedDeletion).toEqual([healthy]);
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      consoleLog.mockRestore();
    }
  });

  test("treats a stale-token completion as lost ownership instead of overwriting a newer lease", async () => {
    const stale = claim(firstKey, firstToken, "publishing");
    const state = fakeLifecycle([stale]);
    let inspected = 0;
    state.lifecycle.withClaim = () => Promise.resolve({ acquired: false });
    const blobs = coordinatedBlobs({
      inspect: () => {
        inspected += 1;
        return { temporary: false, live: true };
      },
    });

    expect(
      await processAttachmentBlobLifecycle({
        lifecycle: state.lifecycle,
        maintenance: createAttachmentBlobMaintenance(blobs),
      }),
    ).toEqual({ claimed: 1, completed: 0, retried: 0, lost: 1 });
    expect(state.released).toEqual([]);
    expect(inspected).toBe(0);
  });
});

function coordinatedBlobs(overrides: {
  inspect?: (key: string) => { temporary: boolean; live: boolean };
  publish?: (key: string) => boolean;
  delete?: (key: string) => boolean;
}) {
  return {
    withKey<T>(
      key: string,
      operation: (lease: {
        inspect(): Promise<{ temporary: boolean; live: boolean }>;
        publish(): Promise<boolean>;
        delete(): Promise<boolean>;
      }) => Promise<T>,
    ) {
      return operation({
        inspect: () =>
          Promise.resolve(
            overrides.inspect?.(key) ?? { temporary: false, live: false },
          ),
        publish: () => Promise.resolve(overrides.publish?.(key) ?? false),
        delete: () => Promise.resolve(overrides.delete?.(key) ?? true),
      });
    },
  };
}
