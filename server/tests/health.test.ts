import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const app = createApp(
  loadConfig({
    ...testEnvironment(),
  }),
);

describe("health endpoint", () => {
  test("reports the server as healthy", async () => {
    const response = await app.request("http://openbot.local/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("runtime capabilities", () => {
  test("reports the Intelligence runtime without exposing configuration secrets", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "intelligence",
      durableHistory: true,
      // Names only. The sign-in screen reads this to know which buttons to draw.
      authProviders: ["google"],
      // A boolean, not a list: naming the registered providers would tell anybody who loads the
      // sign-in page which companies use this deployment.
      ssoConfigured: false,
      telegramEnabled: false,
      botUsername: null,
    });
  });

  // The runtime object holds the Intelligence API key and licence token. This endpoint has no
  // authentication, so a projection bug here publishes deployment secrets to anyone who asks.
  test("never serves the Intelligence credentials", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");
    const body = await response.text();
    const parsed = (await new Response(body).json()) as Record<string, unknown>;

    expect(body).not.toContain("tenant-api-key");
    expect(body).not.toContain("license-token");
    // The settings object itself must not be projected, whatever it happens to hold today.
    expect(Object.keys(parsed)).toEqual([
      "mode",
      "durableHistory",
      "authProviders",
      "ssoConfigured",
      "telegramEnabled",
      "botUsername",
    ]);
    // The provider list is names, never the clients and secrets behind them.
    expect(body).not.toContain("google-client-secret");
  });

  test("projects only the public Telegram widget settings", async () => {
    const telegramApp = createApp(
      loadConfig(
        testEnvironment({
          GOOGLE_OAUTH_CLIENT_ID: undefined,
          GOOGLE_OAUTH_CLIENT_SECRET: undefined,
          INITIAL_ADMIN_EMAILS: undefined,
          BETTER_AUTH_URL: undefined,
          OPENBOT_PUBLIC_URL: "https://work.kolodahearthstone.com",
          TELEGRAM_LOGIN_BOT_USERNAME: "ManacostTeamBot",
          TELEGRAM_LOGIN_BOT_TOKEN: "123456:not-for-the-browser",
          TELEGRAM_ALLOWED_USER_IDS: "810001,810002",
          TELEGRAM_OWNER_USER_IDS: "810001",
          TRUSTED_ORIGINS: "https://internal-auth.example",
        }),
      ),
    );

    const response = await telegramApp.request(
      "http://openbot.local/api/capabilities",
    );
    const body = await response.text();
    const parsed = (await new Response(body).json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(parsed).toEqual({
      mode: "intelligence",
      durableHistory: true,
      authProviders: [],
      ssoConfigured: false,
      telegramEnabled: true,
      botUsername: "ManacostTeamBot",
    });
    expect(Object.keys(parsed)).toEqual([
      "mode",
      "durableHistory",
      "authProviders",
      "ssoConfigured",
      "telegramEnabled",
      "botUsername",
    ]);
    expect(body).not.toContain("not-for-the-browser");
    expect(body).not.toContain("810001");
    expect(body).not.toContain("810002");
    expect(body).not.toContain("internal-auth.example");
    expect(body).not.toContain("OPENBOT_PUBLIC_URL");
  });

  test("turns private Telegram callback failures into one generic sign-in result", async () => {
    const telegramApp = createApp(
      loadConfig(
        testEnvironment({
          GOOGLE_OAUTH_CLIENT_ID: undefined,
          GOOGLE_OAUTH_CLIENT_SECRET: undefined,
          INITIAL_ADMIN_EMAILS: undefined,
          BETTER_AUTH_URL: undefined,
          OPENBOT_PUBLIC_URL: "https://work.kolodahearthstone.com",
          TELEGRAM_LOGIN_BOT_USERNAME: "ManacostTeamBot",
          TELEGRAM_LOGIN_BOT_TOKEN: "123456:not-for-the-browser",
          TELEGRAM_ALLOWED_USER_IDS: "810001",
          TELEGRAM_OWNER_USER_IDS: "810001",
        }),
      ),
      {
        handler: () =>
          new Response("private verification detail", {
            status: 401,
            headers: {
              "set-cookie":
                "telegram_login_binding=; Path=/; Max-Age=0; HttpOnly; Secure",
            },
          }),
        api: { getSession: async () => null },
      },
    );

    const response = await telegramApp.request(
      "http://openbot.local/api/auth/telegram/callback?state=bad",
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign?telegramError=1");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await response.text()).toBe("");
  });
});

describe("workspace telemetry mount", () => {
  test("does not accept browser timings without an authenticated user", async () => {
    const response = await app.request(
      "http://openbot.local/api/telemetry/workspace",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ samples: [] }),
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "No identity provider is configured.",
    });
  });
});

describe("authentication availability", () => {
  test("fails loudly when no identity provider has been configured", async () => {
    const response = await app.request(
      "http://openbot.local/api/auth/sign-in/social",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "No identity provider is configured.",
    });
  });

  test("forwards auth requests to the configured Better Auth handler", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response("mounted", { status: 204 }),
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/callback/google",
    );

    expect(response.status).toBe(204);
  });

  test("forwards logout requests to Better Auth", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => null,
        },
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/sign-out",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
  });
});

/**
 * Who may register an identity provider.
 *
 * Better Auth's SSO plugin guards these with a session, which asks only that somebody is signed in.
 * That is the wrong bar: registering an IdP for a domain means anybody it vouches for can sign in,
 * so a plain user reaching it could mint themselves colleagues. These pin the gate in front of it.
 */
describe("identity provider registration", () => {
  function appFor(roles: ("admin" | "user")[], signedIn = true) {
    let reachedHandler = false;
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => {
          reachedHandler = true;
          return new Response(null, { status: 200 });
        },
        api: {
          getSession: async () =>
            signedIn ? { user: { id: "u1", email: "u1@openbot.test" } } : null,
        },
      } as never,
      { rolesForUser: async () => roles },
    );
    return { app, reached: () => reachedHandler };
  }

  const routes = [
    "/api/auth/sso/register",
    "/api/auth/sso/update-provider",
    "/api/auth/sso/delete-provider",
  ];

  test.each(routes)("refuses %s to a plain user", async (route) => {
    const { app, reached } = appFor(["user"]);

    const response = await app.request(`http://openbot.test${route}`, {
      method: "POST",
    });

    expect(response.status).toBe(403);
    // Refused in front of Better Auth, not by it: the plugin would have allowed this.
    expect(reached()).toBe(false);
  });

  test.each(routes)("refuses %s to somebody signed out", async (route) => {
    const { app, reached } = appFor([], false);

    const response = await app.request(`http://openbot.test${route}`, {
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(reached()).toBe(false);
  });

  test.each(routes)("lets an administrator through to %s", async (route) => {
    const { app, reached } = appFor(["admin"]);

    await app.request(`http://openbot.test${route}`, { method: "POST" });

    expect(reached()).toBe(true);
  });

  // Everything else under /api/auth is Better Auth's own business, including sign-in itself, which
  // by definition happens before anybody has a role.
  test("leaves the rest of the auth routes alone", async () => {
    const { app, reached } = appFor([], false);

    await app.request("http://openbot.test/api/auth/sign-in/social", {
      method: "POST",
    });

    expect(reached()).toBe(true);
  });
});
