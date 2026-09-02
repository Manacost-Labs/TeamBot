import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  CatalogueEntryUnknownError,
  type OAuthClient,
} from "../src/plugins/store";

/**
 * `POST /servers/:id/connect`, for a dynamically registered vendor.
 *
 * Notion has no administrator step: nobody pastes a client id, so the first person to connect is
 * the one who makes the deployment introduce itself (RFC 7591) to the vendor. Google Drive is the
 * regression pin for the OLD behaviour, which must survive unchanged for a manually registered
 * vendor: no stored client is still a 409 telling an administrator to add one, and registration is
 * never attempted for it.
 */

/** A real key shape: base64 over 32 bytes, which is what the deployment's own check demands. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role: "user",
    } as never);
    await next();
  };
}

function app(store: {
  oauthClientFor: (serverId: string) => Promise<OAuthClient | null>;
  ensureOAuthClient: (
    serverId: string,
    by: string,
  ) => Promise<OAuthClient | null>;
  disconnectConnection?: (
    serverId: string,
    userId: string,
    by: string,
  ) => Promise<{ disconnected: boolean; vendorRevoked: boolean }>;
}) {
  const routes = createPluginRoutes(
    {
      ...store,
      disconnectConnection:
        store.disconnectConnection ??
        (async () => ({ disconnected: false, vendorRevoked: false })),
    } as never,
    signedIn(),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: ENCRYPTION_KEY,
      // Only the callback asks this. Every test here stops at the authorization URL.
      personHasAccess: async () => true,
    },
  );
  return new Hono().route("/api/plugins", routes);
}

describe("connecting a dynamically registered vendor", () => {
  test("registers a client on first connect and mints an authorization URL with it", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return { clientId: "dyn-1", clientSecret: "" };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(ensureCalls).toEqual([
      { serverId: "notion", by: "person@openbot.test" },
    ]);

    const body = (await response.json()) as { authorizationUrl: string };
    const url = new URL(body.authorizationUrl);
    expect(url.host).toBe("mcp.notion.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("dyn-1");
  });

  test("a refused registration answers 502, naming the vendor", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return null;
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(502);
    expect(ensureCalls.length).toBe(1);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Notion refused this deployment's registration. Try again, and check the vendor's status if it persists.",
    );
  });
});

describe("connecting a manually registered vendor (regression pin)", () => {
  test("still 409s with no client registered, and never attempts self-registration", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return { clientId: "should-not-happen", clientSecret: "x" };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/google-drive/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(ensureCalls).toEqual([]);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("no OAuth client registered");
  });
});

/**
 * Connecting a catalogue vendor that nobody has added to this deployment.
 *
 * The entry exists, so the handler gets past every check it makes about the vendor, and then asks the
 * store for a client — which cannot answer, because there is no server row to hold one. That is an
 * administrator's missing step and the person pressing Connect can do nothing about it, so it is the
 * same 409 as a vendor whose client an administrator has not pasted in yet. It used to be a 500: an
 * unhandled `CatalogueEntryUnknownError` out of `ensureOAuthClient`.
 */
describe("connecting a vendor this deployment has not added", () => {
  test("is the 409 an administrator can act on, not a 500", async () => {
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId) => {
        throw new CatalogueEntryUnknownError(serverId);
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Notion has not been added to this deployment yet. An administrator has to add it first.",
    );
  });
});

describe("disconnecting a personal connector", () => {
  test("uses the signed-in person and returns the vendor outcome", async () => {
    const calls: { serverId: string; userId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async () => null,
      disconnectConnection: async (serverId, userId, by) => {
        calls.push({ serverId, userId, by });
        return { disconnected: true, vendorRevoked: true };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/connections/google-drive",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnected: true,
      vendorRevoked: true,
    });
    expect(calls).toEqual([
      {
        serverId: "google-drive",
        userId: "user-1",
        by: "person@openbot.test",
      },
    ]);
  });

  test("refuses a connector that is not a personal OAuth account", async () => {
    let called = false;
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async () => null,
      disconnectConnection: async () => {
        called = true;
        return { disconnected: true, vendorRevoked: true };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/connections/not-a-vendor",
      { method: "DELETE" },
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    expect(await response.json()).toEqual({
      error: "not-a-vendor is not connected as an individual person.",
    });
  });
});
