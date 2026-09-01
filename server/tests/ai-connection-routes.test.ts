import { describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type {
  OpenRouterKeyValidationFailureCode,
  OpenRouterKeyValidator,
} from "../src/ai-connections/openrouter";
import type {
  PersonalAiConnectionRouteStore,
  PersonalAiConnectionRoutesOptions,
} from "../src/ai-connections/routes";
import { createPersonalAiConnectionRoutes } from "../src/ai-connections/routes";
import type { PersonalAiConnectionStatus } from "../src/ai-connections/store";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

const routeUrl = "https://work.example.test/api/ai-connections";
const allowedOrigins = ["https://work.example.test"];
const actorA = {
  id: "actor-a",
  email: "actor-a@example.test",
  role: "user",
} as const satisfies AuthenticatedActor;
const actorB = {
  id: "actor-b",
  email: "actor-b@example.test",
  role: "user",
} as const satisfies AuthenticatedActor;
const apiKey = "sk-or-route-secret";

const activeStatus: PersonalAiConnectionStatus = {
  provider: "openrouter",
  state: "active",
  validatedAt: new Date("2026-09-01T10:00:00.000Z"),
  disconnectedAt: null,
  updatedAt: new Date("2026-09-01T10:00:01.000Z"),
  safeMetadata: {
    usageUsd: 12.5,
    limitUsd: 50,
    limitRemainingUsd: 37.5,
    isFreeTier: false,
  },
};

const disconnectedStatus: PersonalAiConnectionStatus = {
  provider: "openrouter",
  state: "disconnected",
  validatedAt: new Date("2026-09-01T10:00:00.000Z"),
  disconnectedAt: new Date("2026-09-01T11:00:00.000Z"),
  updatedAt: new Date("2026-09-01T11:00:00.000Z"),
  safeMetadata: { limitUsd: null, limitRemainingUsd: null },
};

type AppFixtureOptions = {
  actor?: AuthenticatedActor | null;
  store?: Partial<PersonalAiConnectionRouteStore>;
  validator?: OpenRouterKeyValidator;
  origins?: string[];
};

function appFor(options: AppFixtureOptions = {}) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const actor = options.actor === undefined ? actorA : options.actor;
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
  const store: PersonalAiConnectionRouteStore = {
    status: options.store?.status ?? (async () => activeStatus),
    connect: options.store?.connect ?? (async () => activeStatus),
    disconnect: options.store?.disconnect ?? (async () => disconnectedStatus),
  };
  const validator: OpenRouterKeyValidator =
    options.validator ??
    Object.freeze({
      validate: async () => ({
        ok: true as const,
        metadata: activeStatus.safeMetadata,
      }),
    });
  const routeOptions: PersonalAiConnectionRoutesOptions = {
    store,
    validator,
    requireUser,
    allowedOrigins: options.origins ?? allowedOrigins,
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createPersonalAiConnectionRoutes(routeOptions));
  return app;
}

function mutationRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: allowedOrigins[0] as string,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("actor-scoped personal AI connection routes", () => {
  test("requires an authenticated actor for every singleton method", async () => {
    let touched = false;
    const app = appFor({
      actor: null,
      store: {
        status: async () => {
          touched = true;
          return activeStatus;
        },
        connect: async () => {
          touched = true;
          return activeStatus;
        },
        disconnect: async () => {
          touched = true;
          return disconnectedStatus;
        },
      },
      validator: Object.freeze({
        validate: async () => {
          touched = true;
          return { ok: true, metadata: {} };
        },
      }),
    });

    const responses = await Promise.all([
      app.request(routeUrl),
      app.request(
        routeUrl,
        mutationRequest({ provider: "openrouter", apiKey }),
      ),
      app.request(routeUrl, {
        method: "DELETE",
        headers: { origin: allowedOrigins[0] as string },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401,
    ]);
    expect(touched).toBe(false);
  });

  test("GET uses only the session actor and explicitly projects safe status", async () => {
    const actorIds: string[] = [];
    const statusWithUntrustedFields = {
      ...activeStatus,
      credentialId: "must-not-leak",
      encryptedValue: "must-not-leak",
      safeMetadata: {
        ...activeStatus.safeMetadata,
        keySuffix: "must-not-leak",
        providerPayload: { apiKey: "must-not-leak" },
      },
    } as unknown as PersonalAiConnectionStatus;
    const app = appFor({
      actor: actorB,
      store: {
        status: async (actorUserId) => {
          actorIds.push(actorUserId);
          return statusWithUntrustedFields;
        },
      },
    });

    const response = await app.request(routeUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await responseJson(response)).toEqual({
      connection: {
        provider: "openrouter",
        state: "active",
        validatedAt: "2026-09-01T10:00:00.000Z",
        disconnectedAt: null,
        updatedAt: "2026-09-01T10:00:01.000Z",
        safeMetadata: {
          usageUsd: 12.5,
          limitUsd: 50,
          limitRemainingUsd: 37.5,
          isFreeTier: false,
        },
      },
    });
    expect(actorIds).toEqual([actorB.id]);
  });

  test("rejects query and actor-addressed enumeration paths before dependencies", async () => {
    let touched = false;
    const app = appFor({
      store: {
        status: async () => {
          touched = true;
          return activeStatus;
        },
        connect: async () => {
          touched = true;
          return activeStatus;
        },
        disconnect: async () => {
          touched = true;
          return disconnectedStatus;
        },
      },
      validator: Object.freeze({
        validate: async () => {
          touched = true;
          return { ok: true, metadata: {} };
        },
      }),
    });

    const getQuery = await app.request(`${routeUrl}?userId=${actorB.id}`);
    const putQuery = await app.request(
      `${routeUrl}?credentialId=guessed`,
      mutationRequest({ provider: "openrouter", apiKey }),
    );
    const deleteQuery = await app.request(`${routeUrl}?user=${actorB.id}`, {
      method: "DELETE",
      headers: { origin: allowedOrigins[0] as string },
    });
    const addressed = await app.request(`${routeUrl}/${actorB.id}`);

    expect([getQuery.status, putQuery.status, deleteQuery.status]).toEqual([
      400, 400, 400,
    ]);
    await expect(getQuery.json()).resolves.toEqual({
      error: "Query parameters are not allowed.",
    });
    expect(addressed.status).toBe(404);
    expect(touched).toBe(false);
  });

  test("requires one trusted Origin and an application/json media type for PUT", async () => {
    let validations = 0;
    const app = appFor({
      validator: Object.freeze({
        validate: async () => {
          validations += 1;
          return { ok: true, metadata: {} };
        },
      }),
    });

    const missingOrigin = await app.request(routeUrl, {
      ...mutationRequest({ provider: "openrouter", apiKey }),
      headers: { "content-type": "application/json" },
    });
    const attackerOrigin = await app.request(
      routeUrl,
      mutationRequest(
        { provider: "openrouter", apiKey },
        { origin: "https://work.example.test.attacker.example" },
      ),
    );
    const nullOrigin = await app.request(
      routeUrl,
      mutationRequest({ provider: "openrouter", apiKey }, { origin: "null" }),
    );
    const malformedOrigin = await app.request(
      routeUrl,
      mutationRequest(
        { provider: "openrouter", apiKey },
        { origin: "not an origin" },
      ),
    );
    const multipleOrigins = await app.request(
      routeUrl,
      mutationRequest(
        { provider: "openrouter", apiKey },
        { origin: "https://work.example.test, https://attacker.example" },
      ),
    );
    const problemJson = await app.request(
      routeUrl,
      mutationRequest(
        { provider: "openrouter", apiKey },
        { "content-type": "application/problem+json" },
      ),
    );
    const jsonWithParameters = await app.request(
      routeUrl,
      mutationRequest(
        { provider: "openrouter", apiKey },
        { "content-type": "application/json; charset=utf-8" },
      ),
    );

    expect([
      missingOrigin.status,
      attackerOrigin.status,
      nullOrigin.status,
      malformedOrigin.status,
      multipleOrigins.status,
    ]).toEqual([403, 403, 403, 403, 403]);
    expect(problemJson.status).toBe(415);
    expect(jsonWithParameters.status).toBe(200);
    expect(validations).toBe(1);
  });

  test("accepts either the request origin or an explicitly configured origin", async () => {
    const requestOriginApp = appFor({ origins: [] });
    const configuredOriginApp = appFor({
      origins: ["https://settings.example.test"],
    });

    const requestOrigin = await requestOriginApp.request(
      routeUrl,
      mutationRequest({ provider: "openrouter", apiKey }),
    );
    const configuredOrigin = await configuredOriginApp.request(
      routeUrl,
      mutationRequest(
        { provider: "openrouter", apiKey },
        { origin: "https://settings.example.test" },
      ),
    );

    expect([requestOrigin.status, configuredOrigin.status]).toEqual([200, 200]);
  });

  test("accepts only the exact OpenRouter write schema", async () => {
    let validations = 0;
    const app = appFor({
      validator: Object.freeze({
        validate: async () => {
          validations += 1;
          return { ok: true, metadata: {} };
        },
      }),
    });
    const invalidBodies = [
      { provider: "chatgpt", apiKey },
      { provider: "openrouter", apiKey, userId: actorB.id },
      { provider: "openrouter", apiKey, credentialId: "guessed" },
      { provider: "openrouter" },
      { provider: "openrouter", apiKey: 42 },
      ["openrouter", apiKey],
      null,
    ];

    const responses = await Promise.all(
      invalidBodies.map((body) => app.request(routeUrl, mutationRequest(body))),
    );
    const malformed = await app.request(
      routeUrl,
      mutationRequest('{"provider":"openrouter","apiKey":'),
    );

    expect(responses.every((response) => response.status === 400)).toBe(true);
    expect(malformed.status).toBe(400);
    expect(validations).toBe(0);
  });

  test("limits PUT bodies to 16 KiB before validation", async () => {
    let touched = false;
    const app = appFor({
      validator: Object.freeze({
        validate: async () => {
          touched = true;
          return { ok: true, metadata: {} };
        },
      }),
      store: {
        connect: async () => {
          touched = true;
          return activeStatus;
        },
      },
    });

    const response = await app.request(
      routeUrl,
      mutationRequest({ provider: "openrouter", apiKey: "x".repeat(17_000) }),
    );

    expect(response.status).toBe(413);
    expect(await responseJson(response)).toEqual({
      error: "Personal AI connection request is too large.",
    });
    expect(touched).toBe(false);
  });

  test.each([
    ["invalid_key", 422, "OpenRouter API key is invalid."],
    ["forbidden", 422, "OpenRouter rejected this API key."],
    ["rate_limited", 429, "OpenRouter key validation is rate limited."],
    ["provider_unavailable", 503, "OpenRouter is temporarily unavailable."],
    ["provider_refused", 502, "OpenRouter refused key validation."],
    ["invalid_response", 502, "OpenRouter returned an invalid response."],
  ] satisfies Array<[OpenRouterKeyValidationFailureCode, number, string]>)(
    "maps validator failure %s to a stable safe response",
    async (code, status, error) => {
      let stored = false;
      const app = appFor({
        validator: Object.freeze({
          validate: async () => ({ ok: false, code }),
        }),
        store: {
          connect: async () => {
            stored = true;
            return activeStatus;
          },
        },
      });

      const response = await app.request(
        routeUrl,
        mutationRequest({ provider: "openrouter", apiKey }),
      );

      expect(response.status).toBe(status);
      expect(await responseJson(response)).toEqual({ error });
      expect(stored).toBe(false);
    },
  );

  test("validates once, stores only for the session actor, and never returns plaintext", async () => {
    let validatorAcceptedSecret = false;
    let requestSignal: AbortSignal | undefined;
    let storeAcceptedSecret = false;
    let connectKeys: string[] = [];
    const returned = {
      ...activeStatus,
      credentialId: "must-not-leak",
      encryptedValue: apiKey,
      safeMetadata: {
        ...activeStatus.safeMetadata,
        keySuffix: apiKey,
      },
    } as unknown as PersonalAiConnectionStatus;
    const app = appFor({
      actor: actorB,
      validator: Object.freeze({
        validate: async (key, options) => {
          validatorAcceptedSecret = key === apiKey;
          requestSignal = options?.signal;
          return {
            ok: true,
            metadata: {
              usageUsd: 12.5,
              limitUsd: 50,
              limitRemainingUsd: 37.5,
              isFreeTier: false,
            },
          };
        },
      }),
      store: {
        connect: async (input) => {
          storeAcceptedSecret = input.plaintext === apiKey;
          connectKeys = Object.keys(input).sort();
          expect(input.actorUserId).toBe(actorB.id);
          expect(input.provider).toBe("openrouter");
          expect(input.safeMetadata).toEqual(activeStatus.safeMetadata);
          return returned;
        },
      },
    });

    const response = await app.request(
      routeUrl,
      mutationRequest({ provider: "openrouter", apiKey }),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(validatorAcceptedSecret).toBe(true);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(storeAcceptedSecret).toBe(true);
    expect(connectKeys).toEqual([
      "actorUserId",
      "plaintext",
      "provider",
      "safeMetadata",
    ]);
    expect(JSON.parse(text)).toEqual({
      connection: {
        provider: "openrouter",
        state: "active",
        validatedAt: "2026-09-01T10:00:00.000Z",
        disconnectedAt: null,
        updatedAt: "2026-09-01T10:00:01.000Z",
        safeMetadata: activeStatus.safeMetadata,
      },
    });
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain("credentialId");
    expect(text).not.toContain("keySuffix");
  });

  test("returns stable generic failures without logging dependency errors", async () => {
    let logCalls = 0;
    let loggedSecret = false;
    const observeLog = (...values: unknown[]) => {
      logCalls += 1;
      if (JSON.stringify(values).includes(apiKey)) loggedSecret = true;
    };
    const consoleSpies = [
      spyOn(console, "log").mockImplementation(observeLog),
      spyOn(console, "warn").mockImplementation(observeLog),
      spyOn(console, "error").mockImplementation(observeLog),
    ];
    try {
      const validatorFailure = appFor({
        validator: Object.freeze({
          validate: async () => {
            throw new Error(`validator failed with ${apiKey}`);
          },
        }),
      });
      const storeFailure = appFor({
        store: {
          status: async () => {
            throw new Error(`status failed with ${apiKey}`);
          },
          connect: async () => {
            throw new Error(`connect failed with ${apiKey}`);
          },
          disconnect: async () => {
            throw new Error(`disconnect failed with ${apiKey}`);
          },
        },
      });

      const responses = await Promise.all([
        validatorFailure.request(
          routeUrl,
          mutationRequest({ provider: "openrouter", apiKey }),
        ),
        storeFailure.request(routeUrl),
        storeFailure.request(
          routeUrl,
          mutationRequest({ provider: "openrouter", apiKey }),
        ),
        storeFailure.request(routeUrl, {
          method: "DELETE",
          headers: { origin: allowedOrigins[0] as string },
        }),
      ]);
      const payloads = await Promise.all(
        responses.map((response) => response.text()),
      );

      expect(responses.map((response) => response.status)).toEqual([
        503, 503, 503, 503,
      ]);
      expect(payloads[0]).toBe(
        JSON.stringify({ error: "OpenRouter is temporarily unavailable." }),
      );
      for (const payload of payloads) expect(payload).not.toContain(apiKey);
      expect(logCalls).toBe(0);
      expect(loggedSecret).toBe(false);
    } finally {
      for (const consoleSpy of consoleSpies) consoleSpy.mockRestore();
    }
  });

  test("DELETE requires an allowlisted origin and an empty body, then remains idempotent", async () => {
    const actorIds: string[] = [];
    const results = [disconnectedStatus, null];
    const app = appFor({
      actor: actorB,
      store: {
        disconnect: async (actorUserId) => {
          actorIds.push(actorUserId);
          return results.shift() ?? null;
        },
      },
    });

    const missingOrigin = await app.request(routeUrl, { method: "DELETE" });
    const attackerOrigin = await app.request(routeUrl, {
      method: "DELETE",
      headers: { origin: "https://attacker.example" },
    });
    const nonempty = await app.request(routeUrl, {
      method: "DELETE",
      headers: { origin: allowedOrigins[0] as string },
      body: "{}",
    });
    const first = await app.request(routeUrl, {
      method: "DELETE",
      headers: { origin: allowedOrigins[0] as string },
    });
    const second = await app.request(routeUrl, {
      method: "DELETE",
      headers: { origin: allowedOrigins[0] as string },
    });

    expect([missingOrigin.status, attackerOrigin.status]).toEqual([403, 403]);
    expect(nonempty.status).toBe(400);
    expect(await nonempty.json()).toEqual({
      error: "A disconnect request must have an empty body.",
    });
    expect(await first.json()).toEqual({
      connection: {
        provider: "openrouter",
        state: "disconnected",
        validatedAt: "2026-09-01T10:00:00.000Z",
        disconnectedAt: "2026-09-01T11:00:00.000Z",
        updatedAt: "2026-09-01T11:00:00.000Z",
        safeMetadata: { limitUsd: null, limitRemainingUsd: null },
      },
    });
    expect(await second.json()).toEqual({ connection: null });
    expect(actorIds).toEqual([actorB.id, actorB.id]);
  });
});
