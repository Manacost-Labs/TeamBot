import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { mintRunAssertion } from "../src/agents/callback-token";
import {
  createPersonalAiCredentialInternalRoutes,
  PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH,
  PERSONAL_AI_CREDENTIAL_REFRESH_PATH,
} from "../src/ai-connections/internal-routes";
import {
  createPersonalAiCredentialLeaseService,
  PersonalAiConnectionRequiredError,
} from "../src/ai-connections/leases";
import {
  createPersonalAiConnectionStore,
  derivePersonalAiCredentialKeyId,
} from "../src/ai-connections/store";
import { decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  credentials,
  personalAiCredentialLeases,
  userAiConnections,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const managedAgentToken = "managed-agent-test-token";
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const actorIds: string[] = [];
const botIds: string[] = [];

async function fixture(provider: "openrouter" | "chatgpt" = "openrouter") {
  const actorUserId = `lease-actor-${randomUUID()}`;
  const botId = `lease-bot-${randomUUID()}`;
  const secret =
    provider === "chatgpt"
      ? authDocument(`initial-${randomUUID()}`)
      : `${provider}-lease-secret-${randomUUID()}`;
  actorIds.push(actorUserId);
  botIds.push(botId);
  await database.insert(users).values({
    id: actorUserId,
    email: `${actorUserId}@example.test`,
    name: "Credential lease actor",
  });
  await database.insert(agents).values({
    id: botId,
    name: "Credential lease Bot",
    type: "remote_ag_ui",
    configuration: {},
  });
  const connections = createPersonalAiConnectionStore({
    database,
    encryptionKey,
  });
  await connections.connect({
    actorUserId,
    provider,
    plaintext: secret,
    safeMetadata: {},
  });
  return { actorUserId, botId, connections, provider, secret };
}

function authDocument(generation: string) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: `${generation}-access-token`,
      refresh_token: `${generation}-refresh-token`,
      id_token: `${generation}-id-token`,
    },
  });
}

function runFor(input: { actorUserId: string; botId: string; runId: string }) {
  return mintRunAssertion(
    {
      actorId: input.actorUserId,
      botId: input.botId,
      runId: input.runId,
    },
    encryptionKey,
  );
}

function internalApp(
  service: ReturnType<typeof createPersonalAiCredentialLeaseService>,
) {
  const app = new Hono();
  app.route(
    "/",
    createPersonalAiCredentialInternalRoutes({
      service,
      encryptionKey,
      managedAgentToken,
    }),
  );
  return app;
}

function redeemRequest(input: { lease: string; run: string; token?: string }) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": input.token ?? managedAgentToken,
    },
    body: JSON.stringify({ lease: input.lease, run: input.run }),
  };
}

async function redeem(
  app: Hono,
  input: { lease: string; run: string; token?: string },
) {
  const response = await app.request(
    `https://work.example.test${PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH}`,
    redeemRequest(input),
  );
  return {
    body: (await response.json()) as Record<string, unknown>,
    cacheControl: response.headers.get("cache-control"),
    status: response.status,
  };
}

async function refresh(
  app: Hono,
  input: {
    lease: string;
    run: string;
    authDocument: string;
    token?: string;
  },
) {
  const response = await app.request(
    `https://work.example.test${PERSONAL_AI_CREDENTIAL_REFRESH_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": input.token ?? managedAgentToken,
      },
      body: JSON.stringify({
        lease: input.lease,
        run: input.run,
        authDocument: input.authDocument,
      }),
    },
  );
  return {
    body:
      response.status === 204
        ? null
        : ((await response.json()) as Record<string, unknown>),
    cacheControl: response.headers.get("cache-control"),
    status: response.status,
  };
}

afterEach(async () => {
  if (botIds.length > 0) {
    await database.delete(agents).where(inArray(agents.id, botIds.splice(0)));
  }
  if (actorIds.length > 0) {
    const ids = actorIds.splice(0);
    await database
      .delete(userAiConnections)
      .where(inArray(userAiConnections.userId, ids));
    await database.delete(credentials).where(
      inArray(
        credentials.keyId,
        ids.flatMap((id) => [
          derivePersonalAiCredentialKeyId(id, "chatgpt"),
          derivePersonalAiCredentialKeyId(id, "openrouter"),
        ]),
      ),
    );
    await database.delete(users).where(inArray(users.id, ids));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("one-time personal AI credential leases", () => {
  test("mints only for a live actor connection and persists identifiers rather than plaintext", async () => {
    const connected = await fixture();
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const runId = `run-${randomUUID()}`;

    const lease = await service.mint({
      actorUserId: connected.actorUserId,
      botId: connected.botId,
      runId,
    });

    const [row] = await database
      .select()
      .from(personalAiCredentialLeases)
      .where(eq(personalAiCredentialLeases.id, lease));
    expect(row).toMatchObject({
      id: lease,
      userId: connected.actorUserId,
      botId: connected.botId,
      runId,
      redeemedAt: null,
    });
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(row)).not.toContain(connected.secret);

    const disconnected = await fixture();
    await disconnected.connections.disconnect(disconnected.actorUserId);
    await expect(
      service.mint({
        actorUserId: disconnected.actorUserId,
        botId: disconnected.botId,
        runId: `run-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(PersonalAiConnectionRequiredError);
  });

  test("redeems an OpenRouter lease once through the managed, signed internal boundary", async () => {
    const connected = await fixture("openrouter");
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const app = internalApp(service);
    const runId = `run-${randomUUID()}`;
    const lease = await service.mint({
      actorUserId: connected.actorUserId,
      botId: connected.botId,
      runId,
    });
    const signedRun = runFor({ ...connected, runId });

    const first = await redeem(app, { lease, run: signedRun });
    expect(first).toEqual({
      status: 200,
      cacheControl: "private, no-store",
      body: { provider: "openrouter", apiKey: connected.secret },
    });
    const replay = await redeem(app, { lease, run: signedRun });
    expect(replay).toEqual({
      status: 403,
      cacheControl: "private, no-store",
      body: { error: "Credential lease is unavailable." },
    });
  });

  test("returns a typed ChatGPT auth document without copying it to errors or logs", async () => {
    const connected = await fixture("chatgpt");
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const app = internalApp(service);
    const runId = `run-${randomUUID()}`;
    const lease = await service.mint({
      actorUserId: connected.actorUserId,
      botId: connected.botId,
      runId,
    });
    const logs: unknown[][] = [];
    const spies = [
      spyOn(console, "log").mockImplementation((...values) =>
        logs.push(values),
      ),
      spyOn(console, "warn").mockImplementation((...values) =>
        logs.push(values),
      ),
      spyOn(console, "error").mockImplementation((...values) =>
        logs.push(values),
      ),
    ];
    try {
      const success = await redeem(app, {
        lease,
        run: runFor({ ...connected, runId }),
      });
      expect(success.body).toEqual({
        provider: "chatgpt",
        authDocument: connected.secret,
      });
      const refusal = await redeem(app, {
        lease,
        run: runFor({ ...connected, runId }),
      });
      expect(JSON.stringify(refusal)).not.toContain(connected.secret);
      expect(JSON.stringify(logs)).not.toContain(connected.secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("gives expired, replayed, disconnected, replaced, actor-swapped, bot-swapped and run-swapped leases one refusal", async () => {
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const app = internalApp(service);
    const refusalResults: Array<Awaited<ReturnType<typeof redeem>>> = [];

    const expired = await fixture();
    const expiredRunId = `run-${randomUUID()}`;
    const expiredLease = await service.mint({
      actorUserId: expired.actorUserId,
      botId: expired.botId,
      runId: expiredRunId,
    });
    await database
      .update(personalAiCredentialLeases)
      .set({ expiresAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(personalAiCredentialLeases.id, expiredLease));
    refusalResults.push(
      await redeem(app, {
        lease: expiredLease,
        run: runFor({ ...expired, runId: expiredRunId }),
      }),
    );

    const replayed = await fixture();
    const replayedRunId = `run-${randomUUID()}`;
    const replayedLease = await service.mint({
      actorUserId: replayed.actorUserId,
      botId: replayed.botId,
      runId: replayedRunId,
    });
    const replayedRun = runFor({ ...replayed, runId: replayedRunId });
    expect(
      (await redeem(app, { lease: replayedLease, run: replayedRun })).status,
    ).toBe(200);
    refusalResults.push(
      await redeem(app, { lease: replayedLease, run: replayedRun }),
    );

    const disconnected = await fixture();
    const disconnectedRunId = `run-${randomUUID()}`;
    const disconnectedLease = await service.mint({
      actorUserId: disconnected.actorUserId,
      botId: disconnected.botId,
      runId: disconnectedRunId,
    });
    await disconnected.connections.disconnect(disconnected.actorUserId);
    refusalResults.push(
      await redeem(app, {
        lease: disconnectedLease,
        run: runFor({ ...disconnected, runId: disconnectedRunId }),
      }),
    );

    const replaced = await fixture();
    const replacedRunId = `run-${randomUUID()}`;
    const replacedLease = await service.mint({
      actorUserId: replaced.actorUserId,
      botId: replaced.botId,
      runId: replacedRunId,
    });
    await replaced.connections.connect({
      actorUserId: replaced.actorUserId,
      provider: "openrouter",
      plaintext: `replacement-${randomUUID()}`,
      safeMetadata: {},
    });
    refusalResults.push(
      await redeem(app, {
        lease: replacedLease,
        run: runFor({ ...replaced, runId: replacedRunId }),
      }),
    );

    const original = await fixture();
    const otherActor = await fixture();
    const originalRunId = `run-${randomUUID()}`;
    const originalLease = await service.mint({
      actorUserId: original.actorUserId,
      botId: original.botId,
      runId: originalRunId,
    });
    refusalResults.push(
      await redeem(app, {
        lease: originalLease,
        run: runFor({
          actorUserId: otherActor.actorUserId,
          botId: original.botId,
          runId: originalRunId,
        }),
      }),
    );
    refusalResults.push(
      await redeem(app, {
        lease: originalLease,
        run: runFor({
          actorUserId: original.actorUserId,
          botId: otherActor.botId,
          runId: originalRunId,
        }),
      }),
    );
    refusalResults.push(
      await redeem(app, {
        lease: originalLease,
        run: runFor({
          actorUserId: original.actorUserId,
          botId: original.botId,
          runId: `run-${randomUUID()}`,
        }),
      }),
    );

    for (const result of refusalResults) {
      expect(result).toEqual({
        status: 403,
        cacheControl: "private, no-store",
        body: { error: "Credential lease is unavailable." },
      });
    }
  });

  test("does not consume a lease for a wrong managed token or invalid signed run", async () => {
    const connected = await fixture();
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const app = internalApp(service);
    const runId = `run-${randomUUID()}`;
    const lease = await service.mint({
      actorUserId: connected.actorUserId,
      botId: connected.botId,
      runId,
    });
    const signedRun = runFor({ ...connected, runId });

    const wrongToken = await redeem(app, {
      lease,
      run: signedRun,
      token: "wrong-managed-token",
    });
    const invalidRun = await redeem(app, { lease, run: "not-signed" });
    expect(wrongToken).toEqual(invalidRun);
    expect(wrongToken.status).toBe(403);
    expect((await redeem(app, { lease, run: signedRun })).status).toBe(200);
  });

  test("refuses a duplicate run id without revealing whose lease already owns it", async () => {
    const first = await fixture();
    const second = await fixture();
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const runId = `run-${randomUUID()}`;
    await service.mint({
      actorUserId: first.actorUserId,
      botId: first.botId,
      runId,
    });

    await expect(
      service.mint({
        actorUserId: second.actorUserId,
        botId: second.botId,
        runId,
      }),
    ).rejects.toMatchObject({
      name: "PersonalAiCredentialLeaseRefusedError",
      message: "Credential lease is unavailable.",
    });
  });

  test("permits exactly one of two concurrent redemptions", async () => {
    const connected = await fixture();
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const runId = `run-${randomUUID()}`;
    const lease = await service.mint({
      actorUserId: connected.actorUserId,
      botId: connected.botId,
      runId,
    });
    const input = {
      lease,
      actorUserId: connected.actorUserId,
      botId: connected.botId,
      runId,
    };

    const results = await Promise.allSettled([
      service.redeem(input),
      service.redeem(input),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const fulfilled = results.find((result) => result.status === "fulfilled");
    expect(fulfilled?.value).toEqual({
      provider: "openrouter",
      apiKey: connected.secret,
    });
  });

  test("atomically persists one actor/run/lease/credential-bound ChatGPT refresh", async () => {
    const connected = await fixture("chatgpt");
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const app = internalApp(service);
    const runId = `run-${randomUUID()}`;
    const lease = await service.mint({
      actorUserId: connected.actorUserId,
      botId: connected.botId,
      runId,
    });
    const signedRun = runFor({ ...connected, runId });
    const [before] = await database
      .select({ credentialId: userAiConnections.credentialId })
      .from(userAiConnections)
      .where(eq(userAiConnections.userId, connected.actorUserId));
    expect((await redeem(app, { lease, run: signedRun })).status).toBe(200);

    const refreshed = authDocument(`refreshed-${randomUUID()}`);
    expect(
      await refresh(app, { lease, run: signedRun, authDocument: refreshed }),
    ).toEqual({
      status: 204,
      cacheControl: "private, no-store",
      body: null,
    });

    const [after] = await database
      .select({
        credentialId: userAiConnections.credentialId,
        encryptedValue: credentials.encryptedValue,
      })
      .from(userAiConnections)
      .innerJoin(
        credentials,
        eq(credentials.id, userAiConnections.credentialId),
      )
      .where(eq(userAiConnections.userId, connected.actorUserId));
    expect(after?.credentialId).toBe(before?.credentialId);
    expect(
      await decryptSecret(encryptionKey, after?.encryptedValue ?? ""),
    ).toBe(refreshed);

    const replay = await refresh(app, {
      lease,
      run: signedRun,
      authDocument: authDocument(`replay-${randomUUID()}`),
    });
    expect(replay).toEqual({
      status: 403,
      cacheControl: "private, no-store",
      body: { error: "Credential refresh is unavailable." },
    });
  });

  test("accepts a valid near-limit ChatGPT document after outer JSON escaping", async () => {
    const connected = await fixture("chatgpt");
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const app = internalApp(service);
    const runId = `run-${randomUUID()}`;
    const lease = await service.mint({
      actorUserId: connected.actorUserId,
      botId: connected.botId,
      runId,
    });
    const signedRun = runFor({ ...connected, runId });
    expect((await redeem(app, { lease, run: signedRun })).status).toBe(200);

    const refreshed = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "near-limit-access-token",
        refresh_token: "near-limit-refresh-token",
      },
      private_metadata: '"'.repeat(120 * 1_024),
    });
    expect(Buffer.byteLength(refreshed)).toBeLessThanOrEqual(256 * 1_024);
    expect(
      Buffer.byteLength(
        JSON.stringify({ lease, run: signedRun, authDocument: refreshed }),
      ),
    ).toBeGreaterThan(258 * 1_024);

    expect(
      await refresh(app, { lease, run: signedRun, authDocument: refreshed }),
    ).toEqual({
      status: 204,
      cacheControl: "private, no-store",
      body: null,
    });
  });

  test("refuses malformed, disconnected, replaced and identity-swapped late refreshes without changing the live generation", async () => {
    const service = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey,
    });
    const refreshed = authDocument(`late-${randomUUID()}`);

    const malformed = await fixture("chatgpt");
    const malformedRunId = `run-${randomUUID()}`;
    const malformedLease = await service.mint({
      actorUserId: malformed.actorUserId,
      botId: malformed.botId,
      runId: malformedRunId,
    });
    const malformedRun = runFor({ ...malformed, runId: malformedRunId });
    const malformedApp = internalApp(service);
    expect(
      (await redeem(malformedApp, { lease: malformedLease, run: malformedRun }))
        .status,
    ).toBe(200);
    expect(
      (
        await refresh(malformedApp, {
          lease: malformedLease,
          run: malformedRun,
          authDocument: "{}",
        })
      ).status,
    ).toBe(403);

    const disconnected = await fixture("chatgpt");
    const disconnectedRunId = `run-${randomUUID()}`;
    const disconnectedLease = await service.mint({
      actorUserId: disconnected.actorUserId,
      botId: disconnected.botId,
      runId: disconnectedRunId,
    });
    const disconnectedRun = runFor({
      ...disconnected,
      runId: disconnectedRunId,
    });
    expect(
      (
        await redeem(malformedApp, {
          lease: disconnectedLease,
          run: disconnectedRun,
        })
      ).status,
    ).toBe(200);
    await disconnected.connections.disconnect(disconnected.actorUserId);
    expect(
      (
        await refresh(malformedApp, {
          lease: disconnectedLease,
          run: disconnectedRun,
          authDocument: refreshed,
        })
      ).status,
    ).toBe(403);

    const replaced = await fixture("chatgpt");
    const replacedRunId = `run-${randomUUID()}`;
    const replacedLease = await service.mint({
      actorUserId: replaced.actorUserId,
      botId: replaced.botId,
      runId: replacedRunId,
    });
    const replacedRun = runFor({ ...replaced, runId: replacedRunId });
    expect(
      (await redeem(malformedApp, { lease: replacedLease, run: replacedRun }))
        .status,
    ).toBe(200);
    const replacement = authDocument(`replacement-${randomUUID()}`);
    await replaced.connections.connect({
      actorUserId: replaced.actorUserId,
      provider: "chatgpt",
      plaintext: replacement,
      safeMetadata: {},
    });
    expect(
      (
        await refresh(malformedApp, {
          lease: replacedLease,
          run: replacedRun,
          authDocument: refreshed,
        })
      ).status,
    ).toBe(403);

    const [current] = await database
      .select({ encryptedValue: credentials.encryptedValue })
      .from(userAiConnections)
      .innerJoin(
        credentials,
        eq(credentials.id, userAiConnections.credentialId),
      )
      .where(eq(userAiConnections.userId, replaced.actorUserId));
    expect(
      await decryptSecret(encryptionKey, current?.encryptedValue ?? ""),
    ).toBe(replacement);

    const other = await fixture("chatgpt");
    const swapped = await refresh(malformedApp, {
      lease: malformedLease,
      run: runFor({
        actorUserId: other.actorUserId,
        botId: malformed.botId,
        runId: malformedRunId,
      }),
      authDocument: refreshed,
    });
    expect(swapped.status).toBe(403);
  });
});
