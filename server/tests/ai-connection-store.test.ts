import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  createPersonalAiConnectionStore,
  derivePersonalAiCredentialKeyId,
  type PersonalAiConnectionAuditEvent,
} from "../src/ai-connections/store";
import { createCredentialStore, decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  credentials,
  userAiConnections,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const actorIds: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function createActor() {
  const actorUserId = `ai-connection-${randomUUID()}`;
  actorIds.push(actorUserId);
  await database.insert(users).values({
    id: actorUserId,
    email: `${actorUserId}@example.test`,
    name: "Personal AI test actor",
  });
  return actorUserId;
}

async function rowsFor(actorUserId: string) {
  const connectionRows = await database
    .select()
    .from(userAiConnections)
    .where(eq(userAiConnections.userId, actorUserId));
  const keyIds = (["chatgpt", "openrouter"] as const).map((provider) =>
    derivePersonalAiCredentialKeyId(actorUserId, provider),
  );
  const credentialRows = await database
    .select()
    .from(credentials)
    .where(inArray(credentials.keyId, keyIds));
  return { connectionRows, credentialRows };
}

afterEach(async () => {
  const ids = actorIds.splice(0);
  if (ids.length === 0) return;

  // Audit history is append-only by design. The random actor IDs make these test events harmless,
  // attributable fixtures; cleanup must not weaken the production mutation guard to remove them.
  await database
    .delete(userAiConnections)
    .where(inArray(userAiConnections.userId, ids));
  const keyIds = ids.flatMap((actorUserId) =>
    (["chatgpt", "openrouter"] as const).map((provider) =>
      derivePersonalAiCredentialKeyId(actorUserId, provider),
    ),
  );
  await database.delete(credentials).where(inArray(credentials.keyId, keyIds));
  await database.delete(users).where(inArray(users.id, ids));
});

afterAll(async () => {
  await database.$client.close();
});

describe("actor-owned personal AI connection store", () => {
  test("rejects provider-specific boundary+1 credentials before encryption or logging", async () => {
    const acceptedActorUserId = await createActor();
    const openRouterActorUserId = await createActor();
    const chatGptActorUserId = await createActor();
    const events: PersonalAiConnectionAuditEvent[] = [];
    const logged: unknown[][] = [];
    const consoleSpies = [
      spyOn(console, "log").mockImplementation((...values) => {
        logged.push(values);
      }),
      spyOn(console, "warn").mockImplementation((...values) => {
        logged.push(values);
      }),
      spyOn(console, "error").mockImplementation((...values) => {
        logged.push(values);
      }),
    ];

    try {
      const store = createPersonalAiConnectionStore({
        database,
        encryptionKey,
      });
      const accepted = "o".repeat(4_096);
      await expect(
        store.connect({
          actorUserId: acceptedActorUserId,
          provider: "openrouter",
          plaintext: accepted,
          safeMetadata: {},
        }),
      ).resolves.toMatchObject({ state: "active" });

      // An invalid encryption key makes the ordering observable: a boundary error must win without
      // invoking WebCrypto. ChatGPT's 256 Ki-character ceiling is deliberately generous enough for
      // the existing auth-document runtime contract while still bounding server memory consumption.
      const rejectingStore = createPersonalAiConnectionStore({
        database,
        encryptionKey: "invalid-aes-key",
        audit: { record: async (event) => events.push(event) },
      });
      const openRouterMarker = "openrouter-marker";
      const chatGptMarker = "chatgpt-marker";
      const oversizedOpenRouter = `${openRouterMarker}${"o".repeat(
        4_097 - openRouterMarker.length,
      )}`;
      const oversizedChatGpt = `${chatGptMarker}${"c".repeat(
        256 * 1_024 + 1 - chatGptMarker.length,
      )}`;

      for (const input of [
        {
          actorUserId: openRouterActorUserId,
          provider: "openrouter" as const,
          plaintext: oversizedOpenRouter,
        },
        {
          actorUserId: chatGptActorUserId,
          provider: "chatgpt" as const,
          plaintext: oversizedChatGpt,
        },
      ]) {
        await expect(
          rejectingStore.connect({ ...input, safeMetadata: {} }),
        ).rejects.toThrow("Personal AI credential exceeds its safe size");
      }

      expect(await rowsFor(openRouterActorUserId)).toEqual({
        connectionRows: [],
        credentialRows: [],
      });
      expect(await rowsFor(chatGptActorUserId)).toEqual({
        connectionRows: [],
        credentialRows: [],
      });
      expect(events).toEqual([]);
      expect(JSON.stringify(logged)).not.toContain("openrouter-marker");
      expect(JSON.stringify(logged)).not.toContain("chatgpt-marker");
    } finally {
      for (const consoleSpy of consoleSpies) consoleSpy.mockRestore();
    }
  });

  test("connects an actor with an encrypted, server-addressed credential and a safe status", async () => {
    const actorUserId = await createActor();
    const events: PersonalAiConnectionAuditEvent[] = [];
    const store = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      audit: { record: async (event) => events.push(event) },
    });

    const status = await store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "openrouter-secret-value",
      safeMetadata: {
        usageUsd: 12.5,
        limitUsd: 50,
        limitRemainingUsd: 37.5,
        isFreeTier: false,
        rateLimit: { requests: 200, interval: "deprecated-must-not-survive" },
        label: "must not survive",
        keySuffix: "sk-sensitive",
        nested: { token: "must not survive" },
      } as never,
      // A transport object may contain extra fields at runtime, but none is an
      // ownership selector. Only actorUserId above addresses storage.
      userId: "somebody-else",
      credentialId: randomUUID(),
    } as never);

    expect(status).toEqual({
      provider: "openrouter",
      state: "active",
      validatedAt: expect.any(Date),
      disconnectedAt: null,
      updatedAt: expect.any(Date),
      safeMetadata: {
        usageUsd: 12.5,
        limitUsd: 50,
        limitRemainingUsd: 37.5,
        isFreeTier: false,
      },
    });

    const { connectionRows, credentialRows } = await rowsFor(actorUserId);
    expect(connectionRows).toHaveLength(1);
    expect(connectionRows[0]?.credentialId).toBe(credentialRows[0]?.id);
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0]?.keyId).toBe(
      derivePersonalAiCredentialKeyId(actorUserId, "openrouter"),
    );
    await expect(
      decryptSecret(encryptionKey, credentialRows[0]?.encryptedValue as string),
    ).resolves.toBe("openrouter-secret-value");

    const outward = JSON.stringify(status);
    expect(outward).not.toContain("openrouter-secret-value");
    expect(outward).not.toContain(credentialRows[0]?.id as string);
    expect(outward).not.toContain("ciphertext");
    expect(outward).not.toContain("keyId");
    expect(outward).not.toContain("sk-sensitive");
    expect(outward).not.toContain("deprecated-must-not-survive");
    expect(events).toEqual([
      {
        action: "connected",
        actorUserId,
        provider: "openrouter",
        state: "active",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("usageUsd");
    expect(JSON.stringify(events)).not.toContain("credential");
  });

  test("atomically replaces the same provider and revokes the old credential", async () => {
    const actorUserId = await createActor();
    const store = createPersonalAiConnectionStore({ database, encryptionKey });
    await store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "old-secret",
      safeMetadata: { limitUsd: 10 },
    });
    const before = await rowsFor(actorUserId);

    const status = await store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "new-secret",
      safeMetadata: { limitUsd: 20 },
    });

    const after = await rowsFor(actorUserId);
    expect(status.safeMetadata).toEqual({ limitUsd: 20 });
    expect(after.connectionRows).toHaveLength(1);
    expect(after.credentialRows).toHaveLength(2);
    expect(
      after.credentialRows.find(
        (row) => row.id === before.credentialRows[0]?.id,
      )?.revokedAt,
    ).toBeInstanceOf(Date);
    const current = after.credentialRows.find(
      (row) => row.id === after.connectionRows[0]?.credentialId,
    );
    expect(current?.revokedAt).toBeNull();
    await expect(
      decryptSecret(encryptionKey, current?.encryptedValue as string),
    ).resolves.toBe("new-secret");

    const auditRows = await database
      .select({
        eventType: auditEvents.eventType,
        targetType: auditEvents.targetType,
        targetId: auditEvents.targetId,
        actorUserId: auditEvents.actorUserId,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, actorUserId));
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row.eventType).sort()).toEqual([
      "personal_ai_connection.connected",
      "personal_ai_connection.replaced",
    ]);
    for (const row of auditRows) {
      expect(row).toMatchObject({
        targetType: "user_ai_connection",
        targetId: actorUserId,
        actorUserId,
        payload: { provider: "openrouter", state: "active" },
      });
      const recorded = JSON.stringify(row);
      expect(recorded).not.toContain("old-secret");
      expect(recorded).not.toContain("new-secret");
      expect(recorded).not.toContain("limitUsd");
      expect(recorded).not.toContain("keyId");
    }
  });

  test("switches provider by revoking and creating inside the same transaction", async () => {
    const actorUserId = await createActor();
    const store = createPersonalAiConnectionStore({ database, encryptionKey });
    await store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "openrouter-secret",
      safeMetadata: {},
    });
    const before = await rowsFor(actorUserId);

    const status = await store.connect({
      actorUserId,
      provider: "chatgpt",
      plaintext: "chatgpt-auth-document",
      safeMetadata: {},
    });

    const after = await rowsFor(actorUserId);
    expect(status.provider).toBe("chatgpt");
    expect(after.connectionRows).toHaveLength(1);
    expect(after.connectionRows[0]?.provider).toBe("chatgpt");
    expect(
      after.credentialRows.find(
        (row) => row.id === before.credentialRows[0]?.id,
      )?.revokedAt,
    ).toBeInstanceOf(Date);
    const current = after.credentialRows.find(
      (row) => row.id === after.connectionRows[0]?.credentialId,
    );
    expect(current?.revokedAt).toBeNull();
    await expect(
      decryptSecret(encryptionKey, current?.encryptedValue as string),
    ).resolves.toBe("chatgpt-auth-document");
  });

  test("rolls credential replacement back when the connection write fails", async () => {
    const actorUserId = await createActor();
    const store = createPersonalAiConnectionStore({ database, encryptionKey });
    await store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "still-live-secret",
      safeMetadata: { limitUsd: 10 },
    });
    const before = await rowsFor(actorUserId);

    const failing = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => new Date(Number.NaN),
    });
    await expect(
      failing.connect({
        actorUserId,
        provider: "openrouter",
        plaintext: "must-roll-back",
        safeMetadata: { limitUsd: 99 },
      }),
    ).rejects.toThrow();

    const after = await rowsFor(actorUserId);
    expect(after.connectionRows).toEqual(before.connectionRows);
    expect(after.credentialRows).toHaveLength(1);
    expect(after.credentialRows[0]?.id).toBe(before.credentialRows[0]?.id);
    expect(after.credentialRows[0]?.revokedAt).toBeNull();
    await expect(
      decryptSecret(
        encryptionKey,
        after.credentialRows[0]?.encryptedValue as string,
      ),
    ).resolves.toBe("still-live-secret");
    expect(JSON.stringify(after)).not.toContain("must-roll-back");
  });

  test("never projects an externally revoked credential as active", async () => {
    const actorUserId = await createActor();
    const store = createPersonalAiConnectionStore({ database, encryptionKey });
    await store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "later-revoked",
      safeMetadata: { limitUsd: 10 },
    });
    const before = await rowsFor(actorUserId);
    const credentialId = before.connectionRows[0]?.credentialId;
    expect(credentialId).toBeDefined();

    await createCredentialStore(database).revoke(credentialId as string);

    const outward = await store.status(actorUserId);
    expect(outward?.state).toBe("disconnected");
    expect(outward?.disconnectedAt).toBeInstanceOf(Date);
    const after = await rowsFor(actorUserId);
    expect(after.connectionRows[0]?.state).toBe("active");
    expect(outward?.disconnectedAt?.getTime()).toBe(
      after.credentialRows[0]?.revokedAt?.getTime(),
    );
  });

  test("captures a connect timestamp only after acquiring the actor lock", async () => {
    const actorUserId = await createActor();
    const actorLocked = deferred();
    const releaseActor = deferred();
    const nowCalled = deferred();
    let nowCalls = 0;
    const expectedTimestamp = new Date("2026-08-31T12:00:00.000Z");
    const blocker = database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${actorUserId}, 0))`,
      );
      actorLocked.resolve();
      await releaseActor.promise;
    });
    await actorLocked.promise;

    const store = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => {
        nowCalls += 1;
        nowCalled.resolve();
        return expectedTimestamp;
      },
    });
    const pendingConnect = store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "timestamp-secret",
      safeMetadata: {},
    });
    const calledWhileLocked = await Promise.race([
      nowCalled.promise.then(() => true),
      Bun.sleep(100).then(() => false),
    ]);

    releaseActor.resolve();
    await blocker;
    const status = await pendingConnect;
    expect(calledWhileLocked).toBe(false);
    expect(nowCalls).toBe(1);
    expect(status.updatedAt).toEqual(expectedTimestamp);
  });

  test("rolls connection and credential writes back when the database audit insert fails", async () => {
    const actorUserId = await createActor();
    const constraintName = `test_personal_ai_audit_${randomUUID().replaceAll("-", "")}`;
    await database.execute(
      sql.raw(
        `alter table "audit_events" add constraint "${constraintName}" check ("target_id" <> '${actorUserId}') not valid`,
      ),
    );

    try {
      const store = createPersonalAiConnectionStore({
        database,
        encryptionKey,
      });
      await expect(
        store.connect({
          actorUserId,
          provider: "openrouter",
          plaintext: "must-roll-back-with-audit",
          safeMetadata: {},
        }),
      ).rejects.toThrow();
      expect(await rowsFor(actorUserId)).toEqual({
        connectionRows: [],
        credentialRows: [],
      });
      const auditRows = await database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.actorUserId, actorUserId));
      expect(auditRows).toEqual([]);
    } finally {
      await database.execute(
        sql.raw(
          `alter table "audit_events" drop constraint if exists "${constraintName}"`,
        ),
      );
    }
  });

  test("treats an injected auditor as an additional transactional gate", async () => {
    const actorUserId = await createActor();
    const store = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      audit: {
        record: async () => {
          throw new Error("test auditor rejected event");
        },
      },
    });

    await expect(
      store.connect({
        actorUserId,
        provider: "openrouter",
        plaintext: "must-roll-back-with-hook",
        safeMetadata: {},
      }),
    ).rejects.toThrow("test auditor rejected event");
    expect(await rowsFor(actorUserId)).toEqual({
      connectionRows: [],
      credentialRows: [],
    });
    const auditRows = await database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, actorUserId));
    expect(auditRows).toEqual([]);
  });

  test("serializes transactional audit hooks and database event order with actor commits", async () => {
    const actorUserId = await createActor();
    const firstAuditEntered = deferred();
    const releaseFirstAudit = deferred();
    const observed: PersonalAiConnectionAuditEvent["action"][] = [];
    const timestamps = [
      new Date("2026-08-31T13:00:00.000Z"),
      new Date("2026-08-31T13:00:01.000Z"),
    ];
    const store = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => timestamps.shift() as Date,
      audit: {
        record: async (event) => {
          if (event.action === "connected") {
            firstAuditEntered.resolve();
            await releaseFirstAudit.promise;
          }
          observed.push(event.action);
        },
      },
    });

    const first = store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "first-concurrent-secret",
      safeMetadata: {},
    });
    await firstAuditEntered.promise;
    const second = store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "second-concurrent-secret",
      safeMetadata: {},
    });
    await Bun.sleep(50);
    releaseFirstAudit.resolve();
    await Promise.all([first, second]);

    expect(observed).toEqual(["connected", "replaced"]);
    const auditRows = await database
      .select({
        eventType: auditEvents.eventType,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, actorUserId))
      .orderBy(auditEvents.createdAt);
    expect(auditRows).toEqual([
      {
        eventType: "personal_ai_connection.connected",
        createdAt: new Date("2026-08-31T13:00:00.000Z"),
      },
      {
        eventType: "personal_ai_connection.replaced",
        createdAt: new Date("2026-08-31T13:00:01.000Z"),
      },
    ]);
  });

  test("disconnects atomically and is safe to repeat or call without a row", async () => {
    const actorUserId = await createActor();
    const missingActorUserId = await createActor();
    const events: PersonalAiConnectionAuditEvent[] = [];
    const store = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      audit: { record: async (event) => events.push(event) },
    });
    await store.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "disconnect-secret",
      safeMetadata: { limitUsd: 10 },
    });

    const first = await store.disconnect(actorUserId);
    const second = await store.disconnect(actorUserId);
    const missing = await store.disconnect(missingActorUserId);
    const status = await store.status(actorUserId);

    expect(first).toEqual({
      provider: "openrouter",
      state: "disconnected",
      validatedAt: expect.any(Date),
      disconnectedAt: expect.any(Date),
      updatedAt: expect.any(Date),
      safeMetadata: { limitUsd: 10 },
    });
    expect(second).toEqual(first);
    expect(status).toEqual(first);
    expect(missing).toBeNull();
    const { credentialRows } = await rowsFor(actorUserId);
    expect(credentialRows[0]?.revokedAt).toBeInstanceOf(Date);
    expect(events.map((event) => event.action)).toEqual([
      "connected",
      "disconnected",
    ]);
  });
});
