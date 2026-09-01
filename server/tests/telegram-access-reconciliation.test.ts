import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomInt, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  reconcileTelegramAccess,
  TelegramAccessReconciliationError,
} from "../src/auth/telegram-access";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  revokedAccess,
  sessions,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const createdUserIds: string[] = [];
const createdEmails: string[] = [];

function telegramId() {
  return String(randomInt(1_000_000_000, 9_000_000_000));
}

async function createTelegramPerson(input: {
  id: string;
  role?: "admin" | "user";
  sessionCount?: number;
  revoked?: boolean;
}) {
  const userId = `telegram-access-${randomUUID()}`;
  const email = `${userId}@telegram.manacost.invalid`;
  createdUserIds.push(userId);
  createdEmails.push(email);
  await database.insert(users).values({
    id: userId,
    email,
    name: "Telegram reconciliation fixture",
  });
  await database.insert(accounts).values({
    id: randomUUID(),
    providerId: "telegram",
    issuer: "telegram",
    accountId: `telegram:${input.id}`,
    userId,
  });
  if (input.role) {
    await database.insert(userRoles).values({ userId, role: input.role });
  }
  for (let index = 0; index < (input.sessionCount ?? 0); index += 1) {
    await database.insert(sessions).values({
      id: randomUUID(),
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
  }
  if (input.revoked) {
    await database.insert(revokedAccess).values({
      email,
      revokedBy: "telegram-access-test-admin",
    });
  }
  return { email, userId };
}

async function sessionCount(userId: string) {
  return (
    await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId))
  ).length;
}

afterEach(async () => {
  if (createdEmails.length > 0) {
    await database
      .delete(revokedAccess)
      .where(inArray(revokedAccess.email, createdEmails.splice(0)));
  }
  if (createdUserIds.length > 0) {
    await database
      .delete(users)
      .where(inArray(users.id, createdUserIds.splice(0)));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("Telegram allowlist reconciliation", () => {
  test("keeps allowed sessions and invalidates every session for a removed ID", async () => {
    const ownerId = telegramId();
    const editorId = telegramId();
    const removedId = telegramId();
    const owner = await createTelegramPerson({
      id: ownerId,
      role: "admin",
      sessionCount: 1,
    });
    const editor = await createTelegramPerson({
      id: editorId,
      role: "user",
      sessionCount: 1,
    });
    const removed = await createTelegramPerson({
      id: removedId,
      role: "user",
      sessionCount: 2,
    });

    const result = await reconcileTelegramAccess(database, {
      allowedUserIds: new Set([ownerId, editorId]),
      ownerUserIds: new Set([ownerId]),
    });

    expect(result).toEqual({
      activeOwners: 1,
      boundAccounts: 3,
      sessionsRevoked: 2,
    });
    expect(await sessionCount(owner.userId)).toBe(1);
    expect(await sessionCount(editor.userId)).toBe(1);
    expect(await sessionCount(removed.userId)).toBe(0);
    expect(JSON.stringify(result)).not.toContain(ownerId);
    expect(JSON.stringify(result)).not.toContain(editorId);
    expect(JSON.stringify(result)).not.toContain(removedId);
  });

  test("explicit database revocation wins even while the ID remains configured", async () => {
    const ownerId = telegramId();
    const revokedEditorId = telegramId();
    await createTelegramPerson({
      id: ownerId,
      role: "admin",
      sessionCount: 1,
    });
    const revokedEditor = await createTelegramPerson({
      id: revokedEditorId,
      role: "user",
      sessionCount: 2,
      revoked: true,
    });

    const result = await reconcileTelegramAccess(database, {
      allowedUserIds: new Set([ownerId, revokedEditorId]),
      ownerUserIds: new Set([ownerId]),
    });

    expect(result.sessionsRevoked).toBe(2);
    expect(await sessionCount(revokedEditor.userId)).toBe(0);
    expect(
      await database
        .select()
        .from(revokedAccess)
        .where(eq(revokedAccess.email, revokedEditor.email)),
    ).toHaveLength(1);
  });

  test("fails before serving when no configured owner has a live binding", async () => {
    const ownerId = telegramId();
    const editorId = telegramId();
    await createTelegramPerson({
      id: editorId,
      role: "user",
      sessionCount: 1,
    });

    await expect(
      reconcileTelegramAccess(database, {
        allowedUserIds: new Set([ownerId, editorId]),
        ownerUserIds: new Set([ownerId]),
      }),
    ).rejects.toMatchObject({ code: "owner_binding_missing" });
  });

  test("a revoked owner is not counted as the required reachable owner", async () => {
    const ownerId = telegramId();
    await createTelegramPerson({
      id: ownerId,
      role: "admin",
      sessionCount: 1,
      revoked: true,
    });

    await expect(
      reconcileTelegramAccess(database, {
        allowedUserIds: new Set([ownerId]),
        ownerUserIds: new Set([ownerId]),
      }),
    ).rejects.toMatchObject({ code: "owner_binding_missing" });
  });

  test("refuses an empty owner set or an owner outside the allowlist", async () => {
    const ownerId = telegramId();
    for (const input of [
      { allowedUserIds: new Set([ownerId]), ownerUserIds: new Set<string>() },
      {
        allowedUserIds: new Set<string>(),
        ownerUserIds: new Set([ownerId]),
      },
    ]) {
      await expect(
        reconcileTelegramAccess(database, input),
      ).rejects.toBeInstanceOf(TelegramAccessReconciliationError);
    }
  });

  test("two replicas reconcile idempotently without restoring or leaking access", async () => {
    const ownerId = telegramId();
    const removedId = telegramId();
    await createTelegramPerson({
      id: ownerId,
      role: "admin",
      sessionCount: 1,
    });
    const removed = await createTelegramPerson({
      id: removedId,
      role: "user",
      sessionCount: 2,
    });
    const input = {
      allowedUserIds: new Set([ownerId]),
      ownerUserIds: new Set([ownerId]),
    };

    const results = await Promise.all([
      reconcileTelegramAccess(database, input),
      reconcileTelegramAccess(database, input),
    ]);

    expect(
      results.reduce((sum, result) => sum + result.sessionsRevoked, 0),
    ).toBe(2);
    expect(results.every((result) => result.activeOwners === 1)).toBe(true);
    expect(await sessionCount(removed.userId)).toBe(0);
  });
});
