import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import { createRequireUser } from "../src/auth/guards";
import { telegramSessionPlugin } from "../src/auth/telegram-plugin";

const BASE_URL = "http://manacost.test";
const SESSION_COOKIE = "better-auth.session_token";

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
    new RegExp(`(?:^|,\\s*)(${SESSION_COOKIE}=[^;]+)`),
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
