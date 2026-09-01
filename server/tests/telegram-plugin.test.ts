import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createRequireUser } from "../src/auth/guards";
import { createTelegramIdentityProvisioner } from "../src/auth/index";
import { InMemoryTelegramLoginOneTimeStorage } from "../src/auth/telegram-login";
import { telegramSessionPlugin } from "../src/auth/telegram-plugin";
import { createDatabase } from "../src/db/client";
import { accounts, userRoles, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const BASE_URL = "http://manacost.test";
const SESSION_COOKIE = "better-auth.session_token";
const TELEGRAM_BASE_URL = "https://manacost.test";
const TELEGRAM_BOT_TOKEN = "123456789:synthetic-plugin-test-token";
const EDITOR_TELEGRAM_ID = "1234567890123";
const OWNER_TELEGRAM_ID = "1234567890124";
const UNKNOWN_TELEGRAM_ID = "1234567890125";

type MemoryDatabase = {
  user: Record<string, unknown>[];
  session: Record<string, unknown>[];
  account: Record<string, unknown>[];
  verification: Record<string, unknown>[];
};

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  const match = setCookie?.match(
    new RegExp(`(?:^|,\\s*)((?:__Secure-)?${SESSION_COOKIE}=[^;]+)`),
  );
  expect(match?.[1]).toBeString();
  return match?.[1] ?? "";
}

function createFixture() {
  const now = new Date();
  const user = {
    id: "telegram-contract-user",
    email: "telegram-contract-user@manacost.invalid",
    emailVerified: true,
    name: "Telegram contract user",
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  const database: MemoryDatabase = {
    user: [user],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: "telegram-contract-secret-that-is-long-enough-for-tests",
    database: memoryAdapter(database),
    plugins: [
      telegramSessionPlugin({
        resolveVerifiedUser: async (request) =>
          request.headers.get("x-contract-proof") === "verified"
            ? { userId: user.id }
            : null,
      }),
    ],
  });

  async function signIn() {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth/telegram/callback`, {
        headers: { "x-contract-proof": "verified" },
      }),
    );
  }

  return { auth, database, signIn, user };
}

describe("Better Auth Telegram session contract", () => {
  test("mints the normal Better Auth cookie and createRequireUser recognizes it", async () => {
    const { auth, database, signIn, user } = createFixture();

    const response = await signIn();

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).not.toContain("telegram_session");
    expect(database.session).toHaveLength(1);

    const cookie = cookieFrom(response);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
    });
    expect(session?.user.id).toBe(user.id);

    const app = new Hono();
    app.get(
      "/protected",
      createRequireUser(auth, {
        rolesForUser: async () => ["user"],
      }),
      (context) => context.json({ actorId: context.var.actor.id }),
    );
    const protectedResponse = await app.request(`${BASE_URL}/protected`, {
      headers: { cookie },
    });
    expect(protectedResponse.status).toBe(200);
    await expect(protectedResponse.json()).resolves.toEqual({
      actorId: user.id,
    });
  });

  test("uses Better Auth sign-out and rejects a deleted database session", async () => {
    const { auth, database, signIn } = createFixture();
    const firstCookie = cookieFrom(await signIn());

    const signOutResponse = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie: firstCookie, origin: BASE_URL },
      }),
    );

    expect(signOutResponse.status).toBe(200);
    expect(database.session).toHaveLength(0);
    await expect(
      auth.api.getSession({
        headers: new Headers({ cookie: firstCookie }),
        query: { disableCookieCache: true },
      }),
    ).resolves.toBeNull();

    const secondCookie = cookieFrom(await signIn());
    expect(database.session).toHaveLength(1);
    database.session.splice(0, 1);

    await expect(
      auth.api.getSession({
        headers: new Headers({ cookie: secondCookie }),
        query: { disableCookieCache: true },
      }),
    ).resolves.toBeNull();
  });

  test("fails closed when no server-side verifier accepts the request", async () => {
    const database: MemoryDatabase = {
      user: [],
      session: [],
      account: [],
      verification: [],
    };
    const auth = betterAuth({
      baseURL: BASE_URL,
      secret: "telegram-contract-secret-that-is-long-enough-for-tests",
      database: memoryAdapter(database),
      plugins: [telegramSessionPlugin()],
    });

    const response = await auth.handler(
      new Request(
        `${BASE_URL}/api/auth/telegram/callback?userId=telegram-contract-user`,
      ),
    );

    expect(response.status).toBe(401);
    expect(database.user).toHaveLength(0);
    expect(database.session).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

function signedTelegramParams(
  telegramId: string,
  overrides: Record<string, string> = {},
): URLSearchParams {
  const fields = new Map<string, string>([
    ["id", telegramId],
    ["first_name", "Ada"],
    ["last_name", "Lovelace"],
    ["username", "ada_test"],
    ["photo_url", "https://t.me/i/userpic/320/ada.jpg"],
    ["auth_date", String(Math.floor(Date.now() / 1_000))],
  ]);
  for (const [name, value] of Object.entries(overrides)) {
    fields.set(name, value);
  }
  const dataCheckString = [...fields]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const key = createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest();
  const hash = createHmac("sha256", key).update(dataCheckString).digest("hex");
  return new URLSearchParams([...fields, ["hash", hash]]);
}

function transientCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  const cookie = setCookie?.split(";", 1)[0] ?? "";
  expect(cookie).toContain("telegram_login_binding=");
  return cookie;
}

function createTelegramFixture(
  options: {
    bindOwner?: boolean;
    bindEditor?: boolean;
    refuseSessions?: boolean;
  } = {},
) {
  const now = new Date();
  const database: MemoryDatabase = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const allowedUserIds = new Set([EDITOR_TELEGRAM_ID, OWNER_TELEGRAM_ID]);
  const ownerUserIds = new Set([OWNER_TELEGRAM_ID]);
  const roleByUserId = new Map<string, "admin" | "user">();
  const refusalReasons: string[] = [];
  const storage = new InMemoryTelegramLoginOneTimeStorage();

  if (options.bindOwner) {
    database.user.push({
      id: "explicitly-bound-owner",
      email: "bound-owner@manacost.invalid",
      emailVerified: true,
      name: "Bound owner",
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    database.account.push({
      id: "explicit-owner-telegram-account",
      accountId: `telegram:${OWNER_TELEGRAM_ID}`,
      providerId: "telegram",
      issuer: "telegram",
      userId: "explicitly-bound-owner",
      createdAt: now,
      updatedAt: now,
    });
    roleByUserId.set("explicitly-bound-owner", "user");
  }
  if (options.bindEditor) {
    database.user.push({
      id: "explicitly-bound-editor",
      email: "bound-editor@manacost.invalid",
      emailVerified: true,
      name: "Bound editor",
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    database.account.push({
      id: "explicit-editor-telegram-account",
      accountId: `telegram:${EDITOR_TELEGRAM_ID}`,
      providerId: "telegram",
      issuer: "telegram",
      userId: "explicitly-bound-editor",
      createdAt: now,
      updatedAt: now,
    });
    roleByUserId.set("explicitly-bound-editor", "user");
  }

  const provisionVerifiedUser = async (login: { id: string }) => {
    const subject = `telegram:${login.id}`;
    const existingAccount = database.account.find(
      (account) =>
        account.providerId === "telegram" && account.accountId === subject,
    );
    if (existingAccount) {
      const userId = String(existingAccount.userId);
      if (ownerUserIds.has(login.id)) roleByUserId.set(userId, "admin");
      return { userId };
    }
    if (ownerUserIds.has(login.id)) return null;

    // Yield once, then re-check: this models a first-writer-wins transactional binding seam.
    await Promise.resolve();
    const raceWinner = database.account.find(
      (account) =>
        account.providerId === "telegram" && account.accountId === subject,
    );
    if (raceWinner) return { userId: String(raceWinner.userId) };

    const userId = `opaque-${randomUUID()}`;
    database.user.push({
      id: userId,
      email: `${randomUUID()}@telegram.manacost.invalid`,
      emailVerified: true,
      name: "Telegram editor",
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    database.account.push({
      id: randomUUID(),
      accountId: subject,
      providerId: "telegram",
      issuer: "telegram",
      userId,
      createdAt: now,
      updatedAt: now,
    });
    roleByUserId.set(userId, "user");
    return { userId };
  };

  const auth = betterAuth({
    baseURL: TELEGRAM_BASE_URL,
    secret: "telegram-plugin-secret-that-is-long-enough-for-tests",
    database: memoryAdapter(database),
    verification: { storeInDatabase: true },
    databaseHooks: options.refuseSessions
      ? {
          session: {
            create: {
              before: async () => {
                throw new Error("synthetic explicit revocation");
              },
            },
          },
        }
      : undefined,
    plugins: [
      telegramSessionPlugin({
        telegram: {
          botToken: TELEGRAM_BOT_TOKEN,
          allowedUserIds,
          ownerUserIds,
          trustedOrigin: TELEGRAM_BASE_URL,
        },
        oneTimeStorage: storage,
        provisionVerifiedUser,
        recordRefusal: async (reason) => {
          refusalReasons.push(reason);
        },
      }),
    ],
  });

  async function issueState(returnPath = "/settings") {
    const response = await auth.handler(
      new Request(
        `${TELEGRAM_BASE_URL}/api/auth/telegram/state?returnPath=${encodeURIComponent(returnPath)}`,
        { method: "POST", headers: { origin: TELEGRAM_BASE_URL } },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const transientCookie = response.headers.get("set-cookie") ?? "";
    expect(transientCookie).toContain("HttpOnly");
    expect(transientCookie).toContain("Secure");
    expect(transientCookie).toContain("SameSite=Lax");
    const body = (await response.json()) as { state: string };
    expect(body).toEqual({ state: expect.stringMatching(/^[a-f0-9]{64}$/) });
    return { state: body.state, cookie: transientCookieFrom(response) };
  }

  async function callback(
    telegramId: string,
    state: string,
    cookie: string,
    overrides: Record<string, string> = {},
  ) {
    const params = signedTelegramParams(telegramId, overrides);
    params.set("state", state);
    return auth.handler(
      new Request(
        `${TELEGRAM_BASE_URL}/api/auth/telegram/callback?${params.toString()}`,
        { headers: { cookie } },
      ),
    );
  }

  return {
    allowedUserIds,
    auth,
    callback,
    database,
    issueState,
    refusalReasons,
    roleByUserId,
  };
}

describe("verified Telegram account binding", () => {
  test("issues state only for POST from the exact trusted origin", async () => {
    const fixture = createTelegramFixture();
    const url = `${TELEGRAM_BASE_URL}/api/auth/telegram/state?returnPath=/`;

    const get = await fixture.auth.handler(
      new Request(url, { headers: { origin: TELEGRAM_BASE_URL } }),
    );
    const missingOrigin = await fixture.auth.handler(
      new Request(url, { method: "POST" }),
    );
    const exactOrigin = await fixture.auth.handler(
      new Request(url, {
        method: "POST",
        headers: { origin: TELEGRAM_BASE_URL },
      }),
    );

    expect([404, 405]).toContain(get.status);
    expect(missingOrigin.status).toBe(401);
    expect(exactOrigin.status).toBe(200);
    await expect(exactOrigin.json()).resolves.toEqual({
      state: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("creates one opaque editor and returns the same normal session user", async () => {
    const fixture = createTelegramFixture();
    const firstState = await fixture.issueState();
    const first = await fixture.callback(
      EDITOR_TELEGRAM_ID,
      firstState.state,
      firstState.cookie,
    );

    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`${TELEGRAM_BASE_URL}/settings`);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    const sessionCookies = first.headers.get("set-cookie") ?? "";
    expect(sessionCookies).toContain("HttpOnly");
    expect(sessionCookies).toContain("Secure");
    expect(sessionCookies).toContain("SameSite=Lax");
    const firstCookie = cookieFrom(first);
    const firstSession = await fixture.auth.api.getSession({
      headers: new Headers({ cookie: firstCookie }),
      query: { disableCookieCache: true },
    });
    expect(firstSession?.user.id).toMatch(/^opaque-/);
    expect(firstSession?.user.email).not.toContain(EDITOR_TELEGRAM_ID);
    expect(fixture.database.user).toHaveLength(1);
    expect(fixture.database.account).toHaveLength(1);
    expect(fixture.database.account[0]).toMatchObject({
      accountId: `telegram:${EDITOR_TELEGRAM_ID}`,
      providerId: "telegram",
      issuer: "telegram",
    });
    expect(fixture.database.account[0]?.accessToken).toBeUndefined();
    expect(fixture.database.account[0]?.refreshToken).toBeUndefined();
    expect(fixture.database.account[0]?.idToken).toBeUndefined();
    expect(fixture.roleByUserId.get(firstSession?.user.id ?? "missing")).toBe(
      "user",
    );

    fixture.roleByUserId.set(firstSession?.user.id ?? "missing", "admin");
    const secondState = await fixture.issueState("/");
    const second = await fixture.callback(
      EDITOR_TELEGRAM_ID,
      secondState.state,
      secondState.cookie,
      { last_name: "Returning" },
    );
    const secondSession = await fixture.auth.api.getSession({
      headers: new Headers({ cookie: cookieFrom(second) }),
      query: { disableCookieCache: true },
    });
    expect(second.status).toBe(302);
    expect(secondSession?.user.id).toBe(firstSession?.user.id);
    expect(fixture.database.user).toHaveLength(1);
    expect(fixture.database.account).toHaveLength(1);
    expect(fixture.roleByUserId.get(firstSession?.user.id ?? "missing")).toBe(
      "admin",
    );
  });

  test("promotes an explicitly bound owner but refuses an unbound owner", async () => {
    const bound = createTelegramFixture({ bindOwner: true });
    const boundState = await bound.issueState();
    const boundResponse = await bound.callback(
      OWNER_TELEGRAM_ID,
      boundState.state,
      boundState.cookie,
    );
    expect(boundResponse.status).toBe(302);
    expect(bound.roleByUserId.get("explicitly-bound-owner")).toBe("admin");

    const unbound = createTelegramFixture();
    const unboundState = await unbound.issueState();
    const unboundResponse = await unbound.callback(
      OWNER_TELEGRAM_ID,
      unboundState.state,
      unboundState.cookie,
    );
    expect(unboundResponse.status).toBe(401);
    expect(unboundResponse.headers.get("cache-control")).toBe("no-store");
    expect(unboundResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(unboundResponse.headers.get("set-cookie")).not.toContain(
      SESSION_COOKIE,
    );
    expect(unbound.database.user).toHaveLength(0);
    expect(unbound.database.account).toHaveLength(0);
    expect(unbound.refusalReasons).toEqual(["owner_binding_required"]);
    expect(JSON.stringify(unbound.refusalReasons)).not.toContain(
      OWNER_TELEGRAM_ID,
    );
    expect(JSON.stringify(unbound.refusalReasons)).not.toContain(
      TELEGRAM_BOT_TOKEN,
    );
  });

  test("unknown and removed ids create neither users nor sessions", async () => {
    const fixture = createTelegramFixture();
    const unknownState = await fixture.issueState();
    const unknown = await fixture.callback(
      UNKNOWN_TELEGRAM_ID,
      unknownState.state,
      unknownState.cookie,
    );
    expect(unknown.status).toBe(401);
    const unknownBody = await unknown.text();

    const removedState = await fixture.issueState();
    fixture.allowedUserIds.delete(EDITOR_TELEGRAM_ID);
    const removed = await fixture.callback(
      EDITOR_TELEGRAM_ID,
      removedState.state,
      removedState.cookie,
      { last_name: "Removed" },
    );
    expect(removed.status).toBe(401);
    const removedBody = await removed.text();
    expect(removedBody).toBe(unknownBody);
    expect(removedBody).not.toContain(EDITOR_TELEGRAM_ID);
    expect(removedBody).not.toContain(TELEGRAM_BOT_TOKEN);
    expect(fixture.refusalReasons).toEqual([
      "not_allowlisted",
      "not_allowlisted",
    ]);
    expect(fixture.database.user).toHaveLength(0);
    expect(fixture.database.account).toHaveLength(0);
    expect(fixture.database.session).toHaveLength(0);
  });

  test("an existing explicitly revoked binding creates no new user or session", async () => {
    const fixture = createTelegramFixture({
      bindEditor: true,
      refuseSessions: true,
    });
    const state = await fixture.issueState();

    const response = await fixture.callback(
      EDITOR_TELEGRAM_ID,
      state.state,
      state.cookie,
    );

    expect(response.status).toBe(401);
    expect(fixture.database.user).toHaveLength(1);
    expect(fixture.database.account).toHaveLength(1);
    expect(fixture.database.session).toHaveLength(0);
    expect(fixture.refusalReasons).toEqual(["session_refused"]);
  });

  test("rejects browser-selected local identity and one-time state replay", async () => {
    const fixture = createTelegramFixture({ bindOwner: true });
    const maliciousState = await fixture.issueState();
    const maliciousParams = signedTelegramParams(EDITOR_TELEGRAM_ID);
    maliciousParams.set("state", maliciousState.state);
    maliciousParams.set("userId", "explicitly-bound-owner");
    const malicious = await fixture.auth.handler(
      new Request(
        `${TELEGRAM_BASE_URL}/api/auth/telegram/callback?${maliciousParams.toString()}`,
        { headers: { cookie: maliciousState.cookie } },
      ),
    );
    expect(malicious.status).toBe(401);
    expect(fixture.database.session).toHaveLength(0);

    const state = await fixture.issueState();
    const accepted = await fixture.callback(
      EDITOR_TELEGRAM_ID,
      state.state,
      state.cookie,
      { last_name: "First" },
    );
    const replayed = await fixture.callback(
      EDITOR_TELEGRAM_ID,
      state.state,
      state.cookie,
      { last_name: "First" },
    );
    expect(accepted.status).toBe(302);
    expect(replayed.status).toBe(401);
    expect(fixture.database.user).toHaveLength(2);
    expect(fixture.database.account).toHaveLength(2);
    expect(fixture.database.session).toHaveLength(1);
  });

  test("concurrent fresh callbacks for one subject create one binding", async () => {
    const fixture = createTelegramFixture();
    const firstState = await fixture.issueState();
    const secondState = await fixture.issueState();

    const [first, second] = await Promise.all([
      fixture.callback(
        EDITOR_TELEGRAM_ID,
        firstState.state,
        firstState.cookie,
        { last_name: "ConcurrentOne" },
      ),
      fixture.callback(
        EDITOR_TELEGRAM_ID,
        secondState.state,
        secondState.cookie,
        { last_name: "ConcurrentTwo" },
      ),
    ]);

    expect([first.status, second.status]).toEqual([302, 302]);
    expect(fixture.database.user).toHaveLength(1);
    expect(fixture.database.account).toHaveLength(1);
    expect(fixture.database.session).toHaveLength(2);
  });
});

const integrationDatabase = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const integrationSubjects: string[] = [];

afterEach(async () => {
  for (const subject of integrationSubjects.splice(0)) {
    const rows = await integrationDatabase
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.providerId, "telegram"),
          eq(accounts.accountId, subject),
        ),
      );
    for (const row of rows) {
      await integrationDatabase.delete(users).where(eq(users.id, row.userId));
    }
  }
});

afterAll(async () => {
  await integrationDatabase.$client.close();
});

function integrationLogin(telegramId: string) {
  return {
    id: telegramId,
    firstName: "Concurrent",
    lastName: "Editor",
    username: "concurrent_editor",
    authDate: Math.floor(Date.now() / 1_000),
    replayKey: createHash("sha256").update(randomUUID()).digest("hex"),
  };
}

describe("transactional Telegram identity provisioning", () => {
  test("concurrent database provisioning creates one user, account and user role", async () => {
    const telegramId = String(randomInt(1_000_000_000, 9_000_000_000));
    const subject = `telegram:${telegramId}`;
    integrationSubjects.push(subject);
    const provision = createTelegramIdentityProvisioner(
      integrationDatabase,
      new Set(["9999999999999"]),
    );

    const [first, second] = await Promise.all([
      provision(integrationLogin(telegramId)),
      provision(integrationLogin(telegramId)),
    ]);
    expect(first?.userId).toBe(second?.userId);

    const boundAccounts = await integrationDatabase
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.providerId, "telegram"),
          eq(accounts.accountId, subject),
        ),
      );
    expect(boundAccounts).toHaveLength(1);
    expect(boundAccounts[0]).toMatchObject({
      providerId: "telegram",
      issuer: "telegram",
      accountId: subject,
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
    const boundUsers = await integrationDatabase
      .select()
      .from(users)
      .where(eq(users.id, boundAccounts[0]!.userId));
    expect(boundUsers).toHaveLength(1);
    expect(boundUsers[0]?.email).not.toContain(telegramId);
    const editorRoles = await integrationDatabase
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, boundAccounts[0]!.userId));
    expect(editorRoles).toEqual([{ role: "user" }]);

    await integrationDatabase
      .delete(userRoles)
      .where(eq(userRoles.userId, boundAccounts[0]!.userId));
    await integrationDatabase.insert(userRoles).values({
      userId: boundAccounts[0]!.userId,
      role: "admin",
    });
    await provision(integrationLogin(telegramId));
    const preservedRoles = await integrationDatabase
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, boundAccounts[0]!.userId));
    expect(preservedRoles).toEqual([{ role: "admin" }]);
  });

  test("an owner is admitted only after an explicit immutable account binding", async () => {
    const telegramId = String(randomInt(1_000_000_000, 9_000_000_000));
    const subject = `telegram:${telegramId}`;
    integrationSubjects.push(subject);
    const provision = createTelegramIdentityProvisioner(
      integrationDatabase,
      new Set([telegramId]),
    );
    await expect(provision(integrationLogin(telegramId))).resolves.toBeNull();

    const userId = `bound-owner-${randomUUID()}`;
    await integrationDatabase.insert(users).values({
      id: userId,
      email: `${randomUUID()}@telegram.manacost.invalid`,
      name: "Explicitly bound owner",
      emailVerified: true,
    });
    await integrationDatabase.insert(accounts).values({
      id: randomUUID(),
      providerId: "telegram",
      issuer: "telegram",
      accountId: subject,
      userId,
    });

    await expect(provision(integrationLogin(telegramId))).resolves.toEqual({
      userId,
    });
    const ownerRoles = await integrationDatabase
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    expect(ownerRoles).toEqual([{ role: "admin" }]);
  });
});
