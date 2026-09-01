import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { mintRunAssertion } from "../src/agents/callback-token";
import {
  createPersonalAiCredentialInternalRoutes,
  PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH,
} from "../src/ai-connections/internal-routes";
import {
  createPersonalAiCredentialLeaseService,
  PersonalAiConnectionRequiredError,
} from "../src/ai-connections/leases";
import {
  createPersonalAiConnectionStore,
  derivePersonalAiCredentialKeyId,
} from "../src/ai-connections/store";
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
  const secret = `${provider}-lease-secret-${randomUUID()}`;
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
});
