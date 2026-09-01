import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  assertConfiguredTelegramOwnerId,
  parseTelegramOwnerBindingArguments,
  readTelegramOwnerIdFromStdin,
  TelegramOwnerBindingCliError,
} from "../../scripts/bind-telegram-owner";
import {
  bindTelegramOwner,
  parseTelegramOwnerIdInput,
  TelegramOwnerBindingError,
} from "../src/auth/telegram-owner-binding";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  channelMemberships,
  channels,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const LEGACY_OWNER_ID = "dev-local-user";
const createdUserIds = new Set<string>();
const createdChannelIds = new Set<string>();

async function createLegacyOwner() {
  await database.insert(users).values({
    id: LEGACY_OWNER_ID,
    email: "dev@openbot.local",
    name: "Existing owner history",
    emailVerified: false,
  });
  createdUserIds.add(LEGACY_OWNER_ID);
}

async function createOtherUser() {
  const id = `telegram-binding-other-${randomUUID()}`;
  createdUserIds.add(id);
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Other user",
  });
  return id;
}

async function createOwnerHistory() {
  const channelId = `telegram-binding-channel-${randomUUID()}`;
  createdChannelIds.add(channelId);
  await database.insert(channels).values({
    id: channelId,
    name: "Existing owner channel",
    description: "Must remain attached to the legacy owner",
  });
  await database.insert(channelMemberships).values({
    channelId,
    userId: LEGACY_OWNER_ID,
  });
  return channelId;
}

async function telegramAccounts() {
  return database
    .select()
    .from(accounts)
    .where(eq(accounts.providerId, "telegram"));
}

afterEach(async () => {
  for (const channelId of createdChannelIds) {
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  createdChannelIds.clear();

  for (const userId of createdUserIds) {
    await database.delete(users).where(eq(users.id, userId));
  }
  createdUserIds.clear();
});

afterAll(async () => {
  await database.$client.close();
});

describe("Telegram owner id input", () => {
  test("accepts one canonical numeric id from stdin without trimming an argument", () => {
    expect(parseTelegramOwnerIdInput("1234567890123\n")).toBe("1234567890123");
  });

  for (const invalid of [
    "",
    "0\n",
    "01\n",
    "-1\n",
    "1.5\n",
    "123 456\n",
    "123\n456\n",
    "9007199254740992\n",
  ]) {
    test(`refuses malformed stdin ${JSON.stringify(invalid)}`, () => {
      expect(() => parseTelegramOwnerIdInput(invalid)).toThrow(
        TelegramOwnerBindingError,
      );
    });
  }
});

describe("Telegram owner binding command input", () => {
  test("loads owner IDs from the protected operator file after the base environment", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["bind:telegram-owner"]).toBe(
      "env -u TELEGRAM_OWNER_USER_IDS bun --env-file=.env --env-file=.env.manacostteam-auth scripts/bind-telegram-owner.ts",
    );
  });

  test("protected owner IDs override an inherited process value", () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-owner-env-"));
    try {
      writeFileSync(join(directory, ".env"), "TELEGRAM_OWNER_USER_IDS=111\n");
      writeFileSync(
        join(directory, ".env.manacostteam-auth"),
        "TELEGRAM_OWNER_USER_IDS=222\n",
      );

      const result = spawnSync(
        "env",
        [
          "-u",
          "TELEGRAM_OWNER_USER_IDS",
          process.execPath,
          "--env-file=.env",
          "--env-file=.env.manacostteam-auth",
          "-e",
          "process.stdout.write(process.env.TELEGRAM_OWNER_USER_IDS ?? '')",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, TELEGRAM_OWNER_USER_IDS: "333" },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("222");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("is dry-run by default and accepts only the explicit apply flag", () => {
    expect(parseTelegramOwnerBindingArguments([])).toEqual({
      apply: false,
      help: false,
    });
    expect(parseTelegramOwnerBindingArguments(["--apply"])).toEqual({
      apply: true,
      help: false,
    });
    expect(parseTelegramOwnerBindingArguments(["--help"])).toEqual({
      apply: false,
      help: true,
    });
  });

  for (const invalid of [
    ["1234567890123"],
    ["--owner", "1234567890123"],
    ["--apply", "1234567890123"],
    ["--apply", "--help"],
    ["--apply", "--apply"],
    ["--unknown"],
  ]) {
    test(`refuses positional or unknown arguments ${JSON.stringify(invalid)}`, () => {
      expect(() => parseTelegramOwnerBindingArguments(invalid)).toThrow(
        TelegramOwnerBindingCliError,
      );
    });
  }

  test("does not repeat a rejected positional ID in its error", () => {
    const submittedId = "1234567890123";
    try {
      parseTelegramOwnerBindingArguments([submittedId]);
      throw new Error("expected argument rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramOwnerBindingCliError);
      expect((error as Error).message).not.toContain(submittedId);
    }
  });

  test("accepts only an owner named in protected configuration", () => {
    expect(
      assertConfiguredTelegramOwnerId(
        "1234567890123",
        "1111111111111, 1234567890123",
      ),
    ).toBe("1234567890123");
    expect(() =>
      assertConfiguredTelegramOwnerId(
        "1234567890123",
        "1111111111111,2222222222222",
      ),
    ).toThrow(TelegramOwnerBindingCliError);
  });

  for (const configured of [
    undefined,
    "",
    "0",
    "1234567890123,1234567890123",
    "1234567890123, bad",
  ]) {
    test(`fails closed on protected owner configuration ${JSON.stringify(configured)}`, () => {
      expect(() =>
        assertConfiguredTelegramOwnerId("1234567890123", configured),
      ).toThrow(TelegramOwnerBindingCliError);
    });
  }

  test("reads only a bounded single ID from stdin", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234567890123\n"));
        controller.close();
      },
    });

    await expect(readTelegramOwnerIdFromStdin(stream)).resolves.toBe(
      "1234567890123",
    );
  });

  test("stops oversized stdin before parsing it", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1".repeat(65)));
        controller.close();
      },
    });

    await expect(readTelegramOwnerIdFromStdin(stream)).rejects.toBeInstanceOf(
      TelegramOwnerBindingCliError,
    );
  });
});

describe("idempotent Telegram owner binding", () => {
  test("dry-run is the default behavior and writes nothing", async () => {
    await createLegacyOwner();
    const channelId = await createOwnerHistory();

    const result = await bindTelegramOwner(database, {
      telegramId: "1234567890123",
      apply: false,
    });

    expect(result).toEqual({ outcome: "ready", applied: false });
    expect(await telegramAccounts()).toHaveLength(0);
    expect(
      await database
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, LEGACY_OWNER_ID)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, LEGACY_OWNER_ID),
          ),
        ),
    ).toHaveLength(1);
  });

  test("a non-boolean apply value fails safe as a dry-run", async () => {
    await createLegacyOwner();

    const result = await bindTelegramOwner(database, {
      telegramId: "1234567890123",
      apply: "true",
    } as unknown as { telegramId: string; apply: boolean });

    expect(result).toEqual({ outcome: "ready", applied: false });
    expect(await telegramAccounts()).toHaveLength(0);
  });

  test("apply binds the immutable subject without replacing the legacy user or history", async () => {
    await createLegacyOwner();
    const channelId = await createOwnerHistory();
    const [before] = await database
      .select()
      .from(users)
      .where(eq(users.id, LEGACY_OWNER_ID));

    const first = await bindTelegramOwner(database, {
      telegramId: "1234567890123",
      apply: true,
    });
    const second = await bindTelegramOwner(database, {
      telegramId: "1234567890123",
      apply: true,
    });

    expect(first).toEqual({ outcome: "bound", applied: true });
    expect(second).toEqual({ outcome: "already_bound", applied: false });
    const ownerAccounts = await telegramAccounts();
    expect(ownerAccounts).toHaveLength(1);
    expect(ownerAccounts[0]).toMatchObject({
      accountId: "telegram:1234567890123",
      providerId: "telegram",
      issuer: "telegram",
      userId: LEGACY_OWNER_ID,
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
    expect(
      await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, LEGACY_OWNER_ID)),
    ).toEqual([{ role: "admin" }]);
    const [after] = await database
      .select()
      .from(users)
      .where(eq(users.id, LEGACY_OWNER_ID));
    expect(after).toMatchObject({
      id: before?.id,
      email: before?.email,
      name: before?.name,
      createdAt: before?.createdAt,
    });
    expect(
      await database
        .select()
        .from(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, LEGACY_OWNER_ID),
          ),
        ),
    ).toHaveLength(1);
  });

  test("repairs the retained owner's administrator role without duplicating the binding", async () => {
    await createLegacyOwner();
    await database.insert(accounts).values({
      id: randomUUID(),
      accountId: "telegram:1234567890123",
      providerId: "telegram",
      issuer: "telegram",
      userId: LEGACY_OWNER_ID,
    });
    await database.insert(userRoles).values({
      userId: LEGACY_OWNER_ID,
      role: "user",
    });

    const result = await bindTelegramOwner(database, {
      telegramId: "1234567890123",
      apply: true,
    });

    expect(result).toEqual({ outcome: "already_bound", applied: true });
    expect(await telegramAccounts()).toHaveLength(1);
    expect(
      await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, LEGACY_OWNER_ID)),
    ).toEqual([{ role: "admin" }]);
  });

  test("reports an existing binding honestly during a dry-run", async () => {
    await createLegacyOwner();
    await database.insert(accounts).values({
      id: randomUUID(),
      accountId: "telegram:1234567890123",
      providerId: "telegram",
      issuer: "telegram",
      userId: LEGACY_OWNER_ID,
    });
    await database.insert(userRoles).values({
      userId: LEGACY_OWNER_ID,
      role: "admin",
    });

    const result = await bindTelegramOwner(database, {
      telegramId: "1234567890123",
      apply: false,
    });

    expect(result).toEqual({ outcome: "already_bound", applied: false });
    expect(await telegramAccounts()).toHaveLength(1);
  });

  test("serializes concurrent reruns into one binding", async () => {
    await createLegacyOwner();

    const results = await Promise.all([
      bindTelegramOwner(database, {
        telegramId: "1234567890123",
        apply: true,
      }),
      bindTelegramOwner(database, {
        telegramId: "1234567890123",
        apply: true,
      }),
    ]);

    expect(results).toContainEqual({ outcome: "bound", applied: true });
    expect(results).toContainEqual({
      outcome: "already_bound",
      applied: false,
    });
    expect(await telegramAccounts()).toHaveLength(1);
  });

  test("allows only one configured subject to win a concurrent target bind", async () => {
    await createLegacyOwner();

    const results = await Promise.allSettled([
      bindTelegramOwner(database, {
        telegramId: "1234567890123",
        apply: true,
      }),
      bindTelegramOwner(database, {
        telegramId: "9876543210123",
        apply: true,
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const [rejected] = results.filter((result) => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "target_conflict" });
    expect(await telegramAccounts()).toHaveLength(1);
  });

  test("fails closed when the retained legacy owner is missing", async () => {
    await expect(
      bindTelegramOwner(database, {
        telegramId: "1234567890123",
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "legacy_owner_missing" });
    expect(await telegramAccounts()).toHaveLength(0);
  });

  test("refuses a Telegram subject already bound to another local user", async () => {
    await createLegacyOwner();
    const otherUserId = await createOtherUser();
    await database.insert(accounts).values({
      id: randomUUID(),
      accountId: "telegram:1234567890123",
      providerId: "telegram",
      issuer: "telegram",
      userId: otherUserId,
    });

    await expect(
      bindTelegramOwner(database, {
        telegramId: "1234567890123",
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "subject_conflict" });
  });

  test("refuses a legacy owner already bound to another Telegram subject", async () => {
    await createLegacyOwner();
    await database.insert(accounts).values({
      id: randomUUID(),
      accountId: "telegram:9876543210123",
      providerId: "telegram",
      issuer: "telegram",
      userId: LEGACY_OWNER_ID,
    });

    await expect(
      bindTelegramOwner(database, {
        telegramId: "1234567890123",
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "target_conflict" });
  });
});
