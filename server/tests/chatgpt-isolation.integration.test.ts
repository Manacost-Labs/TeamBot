import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type ChatGptDeviceAuthAgent,
  ChatGptDeviceFlowUnavailableError,
  createChatGptDeviceFlowService,
} from "../src/ai-connections/device-flows";
import {
  createPersonalAiCredentialLeaseService,
  PersonalAiCredentialLeaseRefusedError,
  PersonalAiCredentialRefreshRefusedError,
} from "../src/ai-connections/leases";
import {
  createPersonalAiConnectionStore,
  derivePersonalAiCredentialKeyId,
} from "../src/ai-connections/store";
import { decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  credentials,
  personalAiCredentialLeases,
  personalAiDeviceFlows,
  userAiConnections,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
// Audit rows are append-only. Keeping fixture time safely behind the retention window lets cleanup
// use the same guarded path as production retention instead of weakening the database trigger.
const NOW = new Date("2020-09-01T12:00:00.000Z");
const EXPIRES_AT = new Date("2020-09-01T12:15:00.000Z");
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const actorIds: string[] = [];
const botIds: string[] = [];

function authDocument(owner: string, generation = "initial") {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: `${owner}-${generation}-access-canary`,
      refresh_token: `${owner}-${generation}-refresh-canary`,
      id_token: `${owner}-${generation}-id-canary`,
    },
  });
}

async function createActor(label: string) {
  const id = `chatgpt-isolation-${label}-${randomUUID()}`;
  actorIds.push(id);
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: `ChatGPT isolation ${label}`,
  });
  return id;
}

async function createBot() {
  const id = `chatgpt-isolation-bot-${randomUUID()}`;
  botIds.push(id);
  await database.insert(agents).values({
    id,
    name: "ChatGPT isolation Bot",
    type: "remote_ag_ui",
    configuration: {},
  });
  return id;
}

function deviceAgent(): ChatGptDeviceAuthAgent & {
  documents: Map<string, string>;
  states: Map<string, "pending" | "completed" | "cancelled">;
  statusCalls: string[];
  cancelCalls: string[];
} {
  return {
    documents: new Map(),
    states: new Map(),
    statusCalls: [],
    cancelCalls: [],
    async start(flowId) {
      this.states.set(flowId, "pending");
      return {
        flowId,
        state: "pending",
        expiresAt: EXPIRES_AT,
        retryable: false,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
    },
    async status(flowId) {
      this.statusCalls.push(flowId);
      return {
        flowId,
        state: this.states.get(flowId) ?? "cancelled",
        expiresAt: EXPIRES_AT,
        retryable: false,
      };
    },
    async cancel(flowId) {
      this.cancelCalls.push(flowId);
      this.states.set(flowId, "cancelled");
      return {
        flowId,
        state: "cancelled",
        expiresAt: EXPIRES_AT,
        retryable: true,
      };
    },
    async collect(flowId) {
      const document = this.documents.get(flowId);
      if (!document) throw new Error("missing fixture document");
      return { provider: "chatgpt", authDocument: document };
    },
  };
}

afterEach(async () => {
  if (actorIds.length === 0 && botIds.length === 0) return;
  const actorsToDelete = actorIds.splice(0);
  const botsToDelete = botIds.splice(0);
  if (actorsToDelete.length > 0) {
    await database.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('openbot.audit_retention_days', '1', true)`,
      );
      await tx
        .delete(auditEvents)
        .where(inArray(auditEvents.actorUserId, actorsToDelete));
    });
    await database
      .delete(personalAiCredentialLeases)
      .where(inArray(personalAiCredentialLeases.userId, actorsToDelete));
    await database
      .delete(personalAiDeviceFlows)
      .where(inArray(personalAiDeviceFlows.userId, actorsToDelete));
    await database
      .delete(userAiConnections)
      .where(inArray(userAiConnections.userId, actorsToDelete));
    await database.delete(credentials).where(
      inArray(
        credentials.keyId,
        actorsToDelete.flatMap((id) => [
          derivePersonalAiCredentialKeyId(id, "chatgpt"),
          derivePersonalAiCredentialKeyId(id, "openrouter"),
        ]),
      ),
    );
  }
  if (botsToDelete.length > 0) {
    await database.delete(agents).where(inArray(agents.id, botsToDelete));
  }
  if (actorsToDelete.length > 0) {
    await database.delete(users).where(inArray(users.id, actorsToDelete));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("ChatGPT cross-user isolation", () => {
  test("keeps concurrent flows, redemption and refresh bound to their actor", async () => {
    const [actorA, actorB, botId] = await Promise.all([
      createActor("actor-a"),
      createActor("actor-b"),
      createBot(),
    ]);
    const agent = deviceAgent();
    const connections = createPersonalAiConnectionStore({
      database,
      encryptionKey: ENCRYPTION_KEY,
      now: () => new Date(NOW),
    });
    const flows = createChatGptDeviceFlowService({
      database,
      connections,
      agent,
      now: () => new Date(NOW),
    });
    const [flowA, flowB] = await Promise.all([
      flows.start(actorA),
      flows.start(actorB),
    ]);

    await expect(flows.status(actorA, flowB.flowId)).rejects.toBeInstanceOf(
      ChatGptDeviceFlowUnavailableError,
    );
    await expect(flows.cancel(actorB, flowA.flowId)).rejects.toBeInstanceOf(
      ChatGptDeviceFlowUnavailableError,
    );
    expect(agent.statusCalls).toEqual([]);
    expect(agent.cancelCalls).toEqual([]);

    const documentA = authDocument("actor-a");
    const documentB = authDocument("actor-b");
    agent.documents.set(flowA.flowId, documentA);
    agent.documents.set(flowB.flowId, documentB);
    agent.states.set(flowA.flowId, "completed");
    agent.states.set(flowB.flowId, "completed");
    await Promise.all([
      flows.status(actorA, flowA.flowId),
      flows.status(actorB, flowB.flowId),
    ]);

    const leases = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey: ENCRYPTION_KEY,
    });
    const runA = `run-a-${randomUUID()}`;
    const runB = `run-b-${randomUUID()}`;
    const [leaseA, leaseB] = await Promise.all([
      leases.mint({ actorUserId: actorA, botId, runId: runA }),
      leases.mint({ actorUserId: actorB, botId, runId: runB }),
    ]);

    await expect(
      leases.redeem({
        lease: leaseB,
        actorUserId: actorA,
        botId,
        runId: runB,
      }),
    ).rejects.toBeInstanceOf(PersonalAiCredentialLeaseRefusedError);
    await expect(
      leases.redeem({
        lease: leaseB,
        actorUserId: actorB,
        botId,
        runId: runA,
      }),
    ).rejects.toBeInstanceOf(PersonalAiCredentialLeaseRefusedError);

    await expect(
      leases.redeem({
        lease: leaseA,
        actorUserId: actorA,
        botId,
        runId: runA,
      }),
    ).resolves.toEqual({ provider: "chatgpt", authDocument: documentA });
    await expect(
      leases.redeem({
        lease: leaseB,
        actorUserId: actorB,
        botId,
        runId: runB,
      }),
    ).resolves.toEqual({ provider: "chatgpt", authDocument: documentB });

    const refreshedB = authDocument("actor-b", "refreshed");
    await expect(
      leases.refresh({
        lease: leaseB,
        actorUserId: actorA,
        botId,
        runId: runB,
        authDocument: authDocument("actor-a", "forged"),
      }),
    ).rejects.toBeInstanceOf(PersonalAiCredentialRefreshRefusedError);
    await expect(
      leases.refresh({
        lease: leaseB,
        actorUserId: actorB,
        botId,
        runId: runB,
        authDocument: refreshedB,
      }),
    ).resolves.toBeUndefined();

    const live = await database
      .select({
        userId: userAiConnections.userId,
        encryptedValue: credentials.encryptedValue,
      })
      .from(userAiConnections)
      .innerJoin(
        credentials,
        eq(credentials.id, userAiConnections.credentialId),
      )
      .where(inArray(userAiConnections.userId, [actorA, actorB]));
    const plaintextByActor = new Map(
      await Promise.all(
        live.map(
          async (row) =>
            [
              row.userId,
              await decryptSecret(ENCRYPTION_KEY, row.encryptedValue),
            ] as const,
        ),
      ),
    );
    expect(plaintextByActor.get(actorA)).toBe(documentA);
    expect(plaintextByActor.get(actorB)).toBe(refreshedB);
  });

  test("retires a reconnected document and refuses its late refresh after service recreation", async () => {
    const actorUserId = await createActor("reconnect");
    const botId = await createBot();
    const agent = deviceAgent();
    const firstConnections = createPersonalAiConnectionStore({
      database,
      encryptionKey: ENCRYPTION_KEY,
      now: () => new Date(NOW),
    });
    const firstService = createChatGptDeviceFlowService({
      database,
      connections: firstConnections,
      agent,
      now: () => new Date(NOW),
    });
    const started = await firstService.start(actorUserId);
    const oldDocument = authDocument("reconnect", "old");
    agent.documents.set(started.flowId, oldDocument);
    agent.states.set(started.flowId, "completed");
    await expect(
      firstService.status(actorUserId, started.flowId),
    ).resolves.toMatchObject({ state: "completed" });

    const leases = createPersonalAiCredentialLeaseService({
      database,
      encryptionKey: ENCRYPTION_KEY,
    });
    const runId = `old-run-${randomUUID()}`;
    const lease = await leases.mint({ actorUserId, botId, runId });
    await leases.redeem({ lease, actorUserId, botId, runId });
    const [oldConnection] = await database
      .select({ credentialId: userAiConnections.credentialId })
      .from(userAiConnections)
      .where(eq(userAiConnections.userId, actorUserId));

    const newDocument = authDocument("reconnect", "new");
    await firstConnections.connect({
      actorUserId,
      provider: "chatgpt",
      plaintext: newDocument,
      safeMetadata: {},
    });

    const restartedConnections = createPersonalAiConnectionStore({
      database,
      encryptionKey: ENCRYPTION_KEY,
      now: () => new Date(NOW.getTime() + 1_000),
    });
    const restartedService = createChatGptDeviceFlowService({
      database,
      connections: restartedConnections,
      agent,
      now: () => new Date(NOW.getTime() + 1_000),
    });
    await expect(
      restartedService.status(actorUserId, started.flowId),
    ).resolves.toMatchObject({ state: "failed" });
    await expect(
      leases.refresh({
        lease,
        actorUserId,
        botId,
        runId,
        authDocument: authDocument("reconnect", "late"),
      }),
    ).rejects.toBeInstanceOf(PersonalAiCredentialRefreshRefusedError);

    const [oldCredential] = await database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, oldConnection!.credentialId));
    const [current] = await database
      .select({
        credentialId: userAiConnections.credentialId,
        encryptedValue: credentials.encryptedValue,
      })
      .from(userAiConnections)
      .innerJoin(
        credentials,
        eq(credentials.id, userAiConnections.credentialId),
      )
      .where(
        and(
          eq(userAiConnections.userId, actorUserId),
          eq(userAiConnections.state, "active"),
        ),
      );
    expect(oldCredential?.revokedAt).toBeInstanceOf(Date);
    expect(current?.credentialId).not.toBe(oldConnection?.credentialId);
    expect(
      await decryptSecret(ENCRYPTION_KEY, current?.encryptedValue ?? ""),
    ).toBe(newDocument);
    expect(JSON.stringify(current)).not.toContain(
      "reconnect-new-access-canary",
    );

    await restartedConnections.disconnect(actorUserId);
    const afterSecondRestart = createPersonalAiConnectionStore({
      database,
      encryptionKey: ENCRYPTION_KEY,
    });
    await expect(afterSecondRestart.status(actorUserId)).resolves.toMatchObject(
      { state: "disconnected" },
    );
  });
});
