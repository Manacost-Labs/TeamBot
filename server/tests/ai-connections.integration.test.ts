import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  createPersonalAiConnectionStore,
  createPersonalAiOwnedCredentialRetirer,
  derivePersonalAiCredentialKeyId,
} from "../src/ai-connections/store";
import { decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  revokedAccess,
  userAiConnections,
  users,
} from "../src/db/schema";
import {
  composeOwnedCredentialRetirers,
  createPeopleStore,
} from "../src/people/store";
import { TEST_POOL } from "./support/database";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const actorIds: string[] = [];
const actorEmails: string[] = [];

async function createActor(label: string) {
  const actorUserId = `ai-ownership-${randomUUID()}`;
  const email = `${label}-${randomUUID()}@example.test`;
  actorIds.push(actorUserId);
  actorEmails.push(email);
  await database.insert(users).values({
    id: actorUserId,
    email,
    name: `Personal AI ${label}`,
  });
  return { actorUserId, email };
}

async function ownedRows(actorUserId: string) {
  const [connection] = await database
    .select()
    .from(userAiConnections)
    .where(eq(userAiConnections.userId, actorUserId));
  const keyIds = (["chatgpt", "openrouter"] as const).map((provider) =>
    derivePersonalAiCredentialKeyId(actorUserId, provider),
  );
  const ownedCredentials = await database
    .select()
    .from(credentials)
    .where(inArray(credentials.keyId, keyIds));
  return { connection: connection ?? null, credentials: ownedCredentials };
}

afterEach(async () => {
  const ids = actorIds.splice(0);
  const emails = actorEmails.splice(0);
  if (ids.length === 0) return;

  await database
    .delete(userAiConnections)
    .where(inArray(userAiConnections.userId, ids));
  const keyIds = ids.flatMap((actorUserId) =>
    (["chatgpt", "openrouter"] as const).map((provider) =>
      derivePersonalAiCredentialKeyId(actorUserId, provider),
    ),
  );
  await database.delete(credentials).where(inArray(credentials.keyId, keyIds));
  await database
    .delete(revokedAccess)
    .where(inArray(revokedAccess.email, emails));
  await database.delete(users).where(inArray(users.id, ids));
});

afterAll(async () => {
  await database.$client.close();
});

describe("personal AI connection ownership", () => {
  test("keeps two users' provider, secret, status and mutations isolated", async () => {
    const owner = await createActor("owner");
    const editor = await createActor("editor");
    const store = createPersonalAiConnectionStore({ database, encryptionKey });

    await store.connect({
      actorUserId: owner.actorUserId,
      provider: "openrouter",
      plaintext: "owner-openrouter-secret",
      safeMetadata: { usageUsd: 11, limitUsd: 100 },
    });
    await store.connect({
      actorUserId: editor.actorUserId,
      provider: "chatgpt",
      plaintext: "editor-chatgpt-document",
      safeMetadata: { isFreeTier: true },
    });

    await store.connect({
      actorUserId: owner.actorUserId,
      provider: "openrouter",
      plaintext: "owner-replacement-secret",
      safeMetadata: { usageUsd: 12, limitUsd: 100 },
    });

    expect(await store.status(owner.actorUserId)).toMatchObject({
      provider: "openrouter",
      state: "active",
      safeMetadata: { usageUsd: 12, limitUsd: 100 },
    });
    expect(await store.status(editor.actorUserId)).toMatchObject({
      provider: "chatgpt",
      state: "active",
      safeMetadata: { isFreeTier: true },
    });

    const ownerRows = await ownedRows(owner.actorUserId);
    const editorRows = await ownedRows(editor.actorUserId);
    const ownerLive = ownerRows.credentials.filter((row) => !row.revokedAt);
    const editorLive = editorRows.credentials.filter((row) => !row.revokedAt);
    expect(ownerLive).toHaveLength(1);
    expect(editorLive).toHaveLength(1);
    expect(ownerRows.connection?.credentialId).toBe(ownerLive[0]?.id);
    expect(editorRows.connection?.credentialId).toBe(editorLive[0]?.id);
    await expect(
      decryptSecret(encryptionKey, ownerLive[0]?.encryptedValue ?? ""),
    ).resolves.toBe("owner-replacement-secret");
    await expect(
      decryptSecret(encryptionKey, editorLive[0]?.encryptedValue ?? ""),
    ).resolves.toBe("editor-chatgpt-document");
  });

  test("serializes concurrent replace and disconnect to active-or-none", async () => {
    const actor = await createActor("race");
    const store = createPersonalAiConnectionStore({ database, encryptionKey });

    await store.connect({
      actorUserId: actor.actorUserId,
      provider: "openrouter",
      plaintext: "initial-race-secret",
      safeMetadata: {},
    });

    await Promise.all([
      store.connect({
        actorUserId: actor.actorUserId,
        provider: "openrouter",
        plaintext: "replacement-race-secret",
        safeMetadata: { limitUsd: 25 },
      }),
      store.disconnect(actor.actorUserId),
    ]);

    const status = await store.status(actor.actorUserId);
    const rows = await ownedRows(actor.actorUserId);
    const live = rows.credentials.filter((row) => !row.revokedAt);
    expect(live.length).toBeLessThanOrEqual(1);
    if (status?.state === "active") {
      expect(live).toHaveLength(1);
      expect(rows.connection?.credentialId).toBe(live[0]?.id);
    } else {
      expect(status?.state).toBe("disconnected");
      expect(live).toHaveLength(0);
    }

    const liveInDatabase = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          inArray(
            credentials.keyId,
            (["chatgpt", "openrouter"] as const).map((provider) =>
              derivePersonalAiCredentialKeyId(actor.actorUserId, provider),
            ),
          ),
          isNull(credentials.revokedAt),
        ),
      );
    expect(liveInDatabase.length).toBeLessThanOrEqual(1);
  });

  test("revoking one person retires only their personal AI connection", async () => {
    const removed = await createActor("removed");
    const retained = await createActor("retained");
    const store = createPersonalAiConnectionStore({ database, encryptionKey });
    await store.connect({
      actorUserId: removed.actorUserId,
      provider: "openrouter",
      plaintext: "removed-person-secret",
      safeMetadata: {},
    });
    await store.connect({
      actorUserId: retained.actorUserId,
      provider: "openrouter",
      plaintext: "retained-person-secret",
      safeMetadata: { limitRemainingUsd: 9 },
    });

    const pluginCalls: string[] = [];
    const people = createPeopleStore(
      database,
      [],
      composeOwnedCredentialRetirers(
        createPersonalAiOwnedCredentialRetirer(store),
        async (userId, by) => {
          pluginCalls.push(`${userId}:${by}`);
          return { retired: 0 };
        },
      ),
    );
    await people.revoke(removed.actorUserId, retained.actorUserId);

    expect(await store.status(removed.actorUserId)).toMatchObject({
      provider: "openrouter",
      state: "disconnected",
    });
    expect(await store.status(retained.actorUserId)).toMatchObject({
      provider: "openrouter",
      state: "active",
      safeMetadata: { limitRemainingUsd: 9 },
    });
    expect(pluginCalls).toEqual([
      `${removed.actorUserId}:${retained.actorUserId}`,
    ]);

    const removedRows = await ownedRows(removed.actorUserId);
    const retainedRows = await ownedRows(retained.actorUserId);
    expect(removedRows.credentials.every((row) => row.revokedAt)).toBe(true);
    const retainedLive = retainedRows.credentials.filter(
      (row) => !row.revokedAt,
    );
    expect(retainedLive).toHaveLength(1);
    await expect(
      decryptSecret(encryptionKey, retainedLive[0]?.encryptedValue ?? ""),
    ).resolves.toBe("retained-person-secret");
  });

  test("attempts every owned-credential retirer before reporting a generic failure", async () => {
    const calls: string[] = [];
    const retire = composeOwnedCredentialRetirers(
      async () => {
        calls.push("personal");
        throw new Error("private personal failure details");
      },
      async () => {
        calls.push("plugins");
        return { retired: 2 };
      },
    );

    await expect(retire("removed-user", "administrator")).rejects.toThrow(
      "One or more owned credentials could not be retired",
    );
    expect(calls.sort()).toEqual(["personal", "plugins"]);
  });
});
