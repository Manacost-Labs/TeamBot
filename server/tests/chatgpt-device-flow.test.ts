import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type ChatGptDeviceAuthAgent,
  type ChatGptDeviceFlowService,
  ChatGptDeviceFlowServiceUnavailableError,
  ChatGptDeviceFlowUnavailableError,
  createChatGptDeviceAuthAgentClient,
  createChatGptDeviceFlowService,
} from "../src/ai-connections/device-flows";
import { createPersonalAiConnectionRoutes } from "../src/ai-connections/routes";
import {
  createPersonalAiConnectionStore,
  derivePersonalAiCredentialKeyId,
} from "../src/ai-connections/store";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  credentials,
  personalAiDeviceFlows,
  userAiConnections,
  users,
} from "../src/db/schema";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const now = new Date("2026-09-01T12:00:00.000Z");
const expiresAt = new Date("2026-09-01T12:15:00.000Z");
const authDocument = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "access-token-canary",
    refresh_token: "refresh-token-canary",
  },
});
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 1 },
);
const actorIds: string[] = [];

async function actor(label: string) {
  const id = `chatgpt-flow-${label}-${randomUUID()}`;
  actorIds.push(id);
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: `ChatGPT flow ${label}`,
  });
  return id;
}

function agentFixture(): ChatGptDeviceAuthAgent & {
  starts: string[];
  statuses: string[];
  cancellations: string[];
  collections: string[];
  state: "pending" | "completed" | "failed" | "cancelled" | "expired";
  statusFailure: boolean;
  collectedDocument: string;
} {
  return {
    starts: [],
    statuses: [],
    cancellations: [],
    collections: [],
    state: "pending",
    statusFailure: false,
    collectedDocument: authDocument,
    async start(flowId) {
      this.starts.push(flowId);
      return {
        flowId,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresAt,
      };
    },
    async status(flowId) {
      this.statuses.push(flowId);
      if (this.statusFailure) throw new Error("agent-output-secret");
      return { flowId, state: this.state, expiresAt };
    },
    async cancel(flowId) {
      this.cancellations.push(flowId);
      return { flowId, state: "cancelled", expiresAt };
    },
    async collect(flowId) {
      this.collections.push(flowId);
      return {
        provider: "chatgpt",
        authDocument: this.collectedDocument,
      };
    },
  };
}

function serviceFor(agent: ChatGptDeviceAuthAgent) {
  const connections = createPersonalAiConnectionStore({
    database,
    encryptionKey,
    now: () => new Date(now),
  });
  return createChatGptDeviceFlowService({
    database,
    connections,
    agent,
    now: () => new Date(now),
  });
}

afterEach(async () => {
  const ids = actorIds.splice(0);
  if (ids.length === 0) return;
  await database
    .delete(personalAiDeviceFlows)
    .where(inArray(personalAiDeviceFlows.userId, ids));
  await database
    .delete(userAiConnections)
    .where(inArray(userAiConnections.userId, ids));
  const keyIds = ids.flatMap((id) =>
    (["chatgpt", "openrouter"] as const).map((provider) =>
      derivePersonalAiCredentialKeyId(id, provider),
    ),
  );
  await database.delete(credentials).where(inArray(credentials.keyId, keyIds));
  await database.delete(users).where(inArray(users.id, ids));
});

afterAll(async () => {
  await database.$client.close();
});

describe("actor-owned ChatGPT device flow", () => {
  test("starts with a server-owned id and persists no verification code", async () => {
    const actorUserId = await actor("start");
    const agent = agentFixture();
    const service = serviceFor(agent);

    const started = await service.start(actorUserId);

    expect(started).toEqual({
      flowId: agent.starts[0],
      state: "pending",
      expiresAt,
      retryable: false,
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    expect(agent.starts).toHaveLength(1);
    const [row] = await database
      .select()
      .from(personalAiDeviceFlows)
      .where(eq(personalAiDeviceFlows.userId, actorUserId));
    expect(row).toMatchObject({
      id: started.flowId,
      userId: actorUserId,
      provider: "chatgpt",
      state: "pending",
      credentialId: null,
      completedAt: null,
    });
    expect(JSON.stringify(row)).not.toContain("ABCD-EFGH");
  });

  test("makes another actor's flow indistinguishable from an unknown id", async () => {
    const owner = await actor("owner");
    const stranger = await actor("stranger");
    const agent = agentFixture();
    const service = serviceFor(agent);
    const started = await service.start(owner);

    await expect(
      service.status(stranger, started.flowId),
    ).rejects.toBeInstanceOf(ChatGptDeviceFlowUnavailableError);
    await expect(
      service.cancel(stranger, started.flowId),
    ).rejects.toBeInstanceOf(ChatGptDeviceFlowUnavailableError);
    await expect(service.status(stranger, randomUUID())).rejects.toBeInstanceOf(
      ChatGptDeviceFlowUnavailableError,
    );
    expect(agent.statuses).toEqual([]);
    expect(agent.cancellations).toEqual([]);
  });

  test("collects only on the server, validates and stores one encrypted connection", async () => {
    const actorUserId = await actor("complete");
    const agent = agentFixture();
    const service = serviceFor(agent);
    const started = await service.start(actorUserId);
    agent.state = "completed";

    const completed = await service.status(actorUserId, started.flowId);

    expect(completed).toEqual({
      flowId: started.flowId,
      state: "completed",
      expiresAt,
      retryable: false,
    });
    expect(agent.collections).toEqual([started.flowId]);
    const [connection] = await database
      .select({
        provider: userAiConnections.provider,
        state: userAiConnections.state,
        credentialId: userAiConnections.credentialId,
        encryptedValue: credentials.encryptedValue,
        revokedAt: credentials.revokedAt,
      })
      .from(userAiConnections)
      .innerJoin(
        credentials,
        eq(credentials.id, userAiConnections.credentialId),
      )
      .where(eq(userAiConnections.userId, actorUserId));
    expect(connection).toMatchObject({
      provider: "chatgpt",
      state: "active",
      revokedAt: null,
    });
    expect(connection?.encryptedValue).not.toContain("access-token-canary");
    await expect(
      decryptSecret(encryptionKey, connection!.encryptedValue),
    ).resolves.toBe(authDocument);
    const [flow] = await database
      .select()
      .from(personalAiDeviceFlows)
      .where(eq(personalAiDeviceFlows.id, started.flowId));
    expect(flow).toMatchObject({
      state: "completed",
      credentialId: connection?.credentialId,
      completedAt: now,
    });
    expect(JSON.stringify(completed)).not.toContain("access-token-canary");
  });

  test("rolls back credential rotation when the completed marker cannot commit", async () => {
    const actorUserId = await actor("atomic-rollback");
    const agent = agentFixture();
    const store = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => new Date(now),
    });
    const service = createChatGptDeviceFlowService({
      database,
      connections: {
        prepareConnection: store.prepareConnection,
        async connectPrepared(transaction, prepared) {
          await store.connectPrepared(transaction, prepared);
          throw new Error("fault after connection writes");
        },
      },
      agent,
      now: () => new Date(now),
    });
    const started = await service.start(actorUserId);
    agent.state = "completed";

    await expect(service.status(actorUserId, started.flowId)).resolves.toEqual({
      flowId: started.flowId,
      state: "failed",
      expiresAt,
      retryable: true,
    });
    const [connection] = await database
      .select()
      .from(userAiConnections)
      .where(eq(userAiConnections.userId, actorUserId));
    const [credential] = await database
      .select()
      .from(credentials)
      .where(
        eq(
          credentials.keyId,
          derivePersonalAiCredentialKeyId(actorUserId, "chatgpt"),
        ),
      );
    const [audit] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, actorUserId),
          eq(auditEvents.eventType, "personal_ai_connection.connected"),
        ),
      );
    expect(connection).toBeUndefined();
    expect(credential).toBeUndefined();
    expect(audit).toBeUndefined();
  });

  test("serializes concurrent completion with a one-connection database pool", async () => {
    const actorUserId = await actor("concurrent-complete");
    const agent = agentFixture();
    const service = serviceFor(agent);
    const started = await service.start(actorUserId);
    agent.state = "completed";
    let releaseCollection = () => undefined;
    let collectionStarted = () => undefined;
    const collectionGate = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    const startedCollection = new Promise<void>((resolve) => {
      collectionStarted = resolve;
    });
    agent.collect = async (flowId) => {
      agent.collections.push(flowId);
      collectionStarted();
      await collectionGate;
      return { provider: "chatgpt", authDocument };
    };

    const completing = service.status(actorUserId, started.flowId);
    await startedCollection;
    const concurrent = await service.status(actorUserId, started.flowId);
    expect(concurrent.state).toBe("pending");
    releaseCollection();

    await expect(completing).resolves.toMatchObject({ state: "completed" });
    await expect(
      service.status(actorUserId, started.flowId),
    ).resolves.toMatchObject({
      state: "completed",
    });
    expect(agent.collections).toEqual([started.flowId]);
  });

  test("commits an OpenRouter replacement and pending-flow invalidation before remote cancellation", async () => {
    const actorUserId = await actor("replace-pending");
    const agent = agentFixture();
    const connections = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => new Date(now),
    });
    const service = createChatGptDeviceFlowService({
      database,
      connections,
      agent,
      now: () => new Date(now),
    });
    const started = await service.start(actorUserId);
    const cancellationObservations: Array<{
      flowState: string | undefined;
      provider: string | undefined;
    }> = [];
    agent.cancel = async (flowId) => {
      agent.cancellations.push(flowId);
      const [flow] = await database
        .select({ state: personalAiDeviceFlows.state })
        .from(personalAiDeviceFlows)
        .where(eq(personalAiDeviceFlows.id, flowId));
      const [connection] = await database
        .select({ provider: userAiConnections.provider })
        .from(userAiConnections)
        .where(eq(userAiConnections.userId, actorUserId));
      cancellationObservations.push({
        flowState: flow?.state,
        provider: connection?.provider,
      });
      return { flowId, state: "cancelled", expiresAt };
    };

    const connected = await connections.connect(
      {
        actorUserId,
        provider: "openrouter",
        plaintext: "sk-or-replacement",
        safeMetadata: {},
      },
      service.cancelInvalidated,
    );

    expect(connected).toMatchObject({
      provider: "openrouter",
      state: "active",
    });
    expect(agent.cancellations).toEqual([started.flowId]);
    expect(cancellationObservations).toEqual([
      { flowState: "cancelled", provider: "openrouter" },
    ]);
  });

  test("commits disconnect and pending-flow invalidation before remote cancellation", async () => {
    const actorUserId = await actor("disconnect-pending");
    const agent = agentFixture();
    const connections = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => new Date(now),
    });
    const service = createChatGptDeviceFlowService({
      database,
      connections,
      agent,
      now: () => new Date(now),
    });
    await connections.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "sk-or-before-disconnect",
      safeMetadata: {},
    });
    const started = await service.start(actorUserId);
    const cancellationObservations: Array<{
      flowState: string | undefined;
      connectionState: string | undefined;
    }> = [];
    agent.cancel = async (flowId) => {
      agent.cancellations.push(flowId);
      const [flow] = await database
        .select({ state: personalAiDeviceFlows.state })
        .from(personalAiDeviceFlows)
        .where(eq(personalAiDeviceFlows.id, flowId));
      const [connection] = await database
        .select({ state: userAiConnections.state })
        .from(userAiConnections)
        .where(eq(userAiConnections.userId, actorUserId));
      cancellationObservations.push({
        flowState: flow?.state,
        connectionState: connection?.state,
      });
      return { flowId, state: "cancelled", expiresAt };
    };

    const disconnected = await connections.disconnect(
      actorUserId,
      service.cancelInvalidated,
    );

    expect(disconnected).toMatchObject({
      provider: "openrouter",
      state: "disconnected",
    });
    expect(agent.cancellations).toEqual([started.flowId]);
    expect(cancellationObservations).toEqual([
      { flowState: "cancelled", connectionState: "disconnected" },
    ]);
  });

  test("rolls back pending-flow invalidation when OpenRouter replacement fails", async () => {
    const actorUserId = await actor("replace-invalidation-rollback");
    const agent = agentFixture();
    const connections = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      audit: {
        record: async () => {
          throw new Error("replacement audit rejected");
        },
      },
      now: () => new Date(now),
    });
    const service = createChatGptDeviceFlowService({
      database,
      connections,
      agent,
      now: () => new Date(now),
    });
    const started = await service.start(actorUserId);

    await expect(
      connections.connect(
        {
          actorUserId,
          provider: "openrouter",
          plaintext: "sk-or-rolled-back-replacement",
          safeMetadata: {},
        },
        service.cancelInvalidated,
      ),
    ).rejects.toThrow("replacement audit rejected");

    const [flow] = await database
      .select({ state: personalAiDeviceFlows.state })
      .from(personalAiDeviceFlows)
      .where(eq(personalAiDeviceFlows.id, started.flowId));
    expect(flow?.state).toBe("pending");
    expect(agent.cancellations).toEqual([]);
    await expect(connections.status(actorUserId)).resolves.toBeNull();
  });

  test("rolls back pending-flow invalidation when disconnect fails", async () => {
    const actorUserId = await actor("disconnect-invalidation-rollback");
    const agent = agentFixture();
    const connections = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => new Date(now),
    });
    await connections.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "sk-or-before-rolled-back-disconnect",
      safeMetadata: {},
    });
    const failingConnections = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      audit: {
        record: async () => {
          throw new Error("disconnect audit rejected");
        },
      },
      now: () => new Date(now),
    });
    const service = createChatGptDeviceFlowService({
      database,
      connections,
      agent,
      now: () => new Date(now),
    });
    const started = await service.start(actorUserId);

    await expect(
      failingConnections.disconnect(actorUserId, service.cancelInvalidated),
    ).rejects.toThrow("disconnect audit rejected");

    const [flow] = await database
      .select({ state: personalAiDeviceFlows.state })
      .from(personalAiDeviceFlows)
      .where(eq(personalAiDeviceFlows.id, started.flowId));
    expect(flow?.state).toBe("pending");
    expect(agent.cancellations).toEqual([]);
    await expect(connections.status(actorUserId)).resolves.toMatchObject({
      provider: "openrouter",
      state: "active",
    });
  });

  test("an OpenRouter replacement wins a collecting-completion race", async () => {
    const actorUserId = await actor("replace-collecting-race");
    const agent = agentFixture();
    const connections = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => new Date(now),
    });
    const service = createChatGptDeviceFlowService({
      database,
      connections,
      agent,
      now: () => new Date(now),
    });
    const started = await service.start(actorUserId);
    agent.state = "completed";
    let releaseCollection = () => undefined;
    let collectionStarted = () => undefined;
    const collectionGate = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    const startedCollection = new Promise<void>((resolve) => {
      collectionStarted = resolve;
    });
    agent.collect = async (flowId) => {
      agent.collections.push(flowId);
      collectionStarted();
      await collectionGate;
      return { provider: "chatgpt", authDocument };
    };

    const completing = service.status(actorUserId, started.flowId);
    await startedCollection;
    await connections.connect(
      {
        actorUserId,
        provider: "openrouter",
        plaintext: "sk-or-race-winner",
        safeMetadata: {},
      },
      service.cancelInvalidated,
    );
    releaseCollection();

    await expect(completing).resolves.toMatchObject({ state: "cancelled" });
    await expect(connections.status(actorUserId)).resolves.toMatchObject({
      provider: "openrouter",
      state: "active",
    });
    expect(agent.cancellations).toEqual([started.flowId]);
  });

  test("disconnect wins a collecting-completion race", async () => {
    const actorUserId = await actor("disconnect-collecting-race");
    const agent = agentFixture();
    const connections = createPersonalAiConnectionStore({
      database,
      encryptionKey,
      now: () => new Date(now),
    });
    const service = createChatGptDeviceFlowService({
      database,
      connections,
      agent,
      now: () => new Date(now),
    });
    await connections.connect({
      actorUserId,
      provider: "openrouter",
      plaintext: "sk-or-before-race-disconnect",
      safeMetadata: {},
    });
    const started = await service.start(actorUserId);
    agent.state = "completed";
    let releaseCollection = () => undefined;
    let collectionStarted = () => undefined;
    const collectionGate = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    const startedCollection = new Promise<void>((resolve) => {
      collectionStarted = resolve;
    });
    agent.collect = async (flowId) => {
      agent.collections.push(flowId);
      collectionStarted();
      await collectionGate;
      return { provider: "chatgpt", authDocument };
    };

    const completing = service.status(actorUserId, started.flowId);
    await startedCollection;
    await connections.disconnect(actorUserId, service.cancelInvalidated);
    releaseCollection();

    await expect(completing).resolves.toMatchObject({ state: "cancelled" });
    await expect(connections.status(actorUserId)).resolves.toMatchObject({
      provider: "openrouter",
      state: "disconnected",
    });
    expect(agent.cancellations).toEqual([started.flowId]);
  });

  test("invalid collected auth stays retryable and creates no connection", async () => {
    const actorUserId = await actor("invalid-auth");
    const agent = agentFixture();
    const service = serviceFor(agent);
    const started = await service.start(actorUserId);
    agent.state = "completed";
    agent.collectedDocument = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "missing-refresh" },
    });

    await expect(service.status(actorUserId, started.flowId)).resolves.toEqual({
      flowId: started.flowId,
      state: "failed",
      expiresAt,
      retryable: true,
    });
    const [connection] = await database
      .select()
      .from(userAiConnections)
      .where(eq(userAiConnections.userId, actorUserId));
    expect(connection).toBeUndefined();
  });

  test("does not store a credential when the flow expires during collection", async () => {
    const actorUserId = await actor("expires-during-collect");
    const agent = agentFixture();
    const service = serviceFor(agent);
    const started = await service.start(actorUserId);
    agent.state = "completed";
    agent.collect = async (flowId) => {
      agent.collections.push(flowId);
      await database
        .update(personalAiDeviceFlows)
        .set({ expiresAt: new Date(now.getTime() - 1) })
        .where(eq(personalAiDeviceFlows.id, flowId));
      return { provider: "chatgpt", authDocument };
    };

    await expect(service.status(actorUserId, started.flowId)).resolves.toEqual({
      flowId: started.flowId,
      state: "expired",
      expiresAt: new Date(now.getTime() - 1),
      retryable: true,
    });
    const [connection] = await database
      .select()
      .from(userAiConnections)
      .where(eq(userAiConnections.userId, actorUserId));
    expect(connection).toBeUndefined();
    expect(agent.cancellations).toEqual([started.flowId]);
  });

  test("cancels a possibly-created remote child when start is ambiguous", async () => {
    const actorUserId = await actor("ambiguous-start");
    const agent = agentFixture();
    agent.start = async (flowId) => {
      agent.starts.push(flowId);
      throw new Error("connection lost after remote start");
    };
    const service = serviceFor(agent);

    await expect(service.start(actorUserId)).rejects.toBeInstanceOf(
      ChatGptDeviceFlowServiceUnavailableError,
    );
    expect(agent.cancellations).toEqual(agent.starts);
    const [flow] = await database
      .select()
      .from(personalAiDeviceFlows)
      .where(eq(personalAiDeviceFlows.userId, actorUserId));
    expect(flow?.state).toBe("failed");
  });

  test("cancels the remote child when the post-start database update is lost", async () => {
    const actorUserId = await actor("lost-start-update");
    const agent = agentFixture();
    agent.start = async (flowId) => {
      agent.starts.push(flowId);
      await database
        .update(personalAiDeviceFlows)
        .set({ state: "cancelled" })
        .where(eq(personalAiDeviceFlows.id, flowId));
      return {
        flowId,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresAt,
        state: "pending",
        retryable: false,
      };
    };
    const service = serviceFor(agent);

    await expect(service.start(actorUserId)).rejects.toBeInstanceOf(
      ChatGptDeviceFlowServiceUnavailableError,
    );
    expect(agent.cancellations).toEqual(agent.starts);
  });

  test("turns restart/unavailable and local expiry into explicit retryable states", async () => {
    const restartActor = await actor("restart");
    const expiryActor = await actor("expiry");
    const restartAgent = agentFixture();
    restartAgent.statusFailure = true;
    const restartService = serviceFor(restartAgent);
    const restarted = await restartService.start(restartActor);

    await expect(
      restartService.status(restartActor, restarted.flowId),
    ).resolves.toEqual({
      flowId: restarted.flowId,
      state: "failed",
      expiresAt,
      retryable: true,
    });

    const expiryAgent = agentFixture();
    const expiryService = serviceFor(expiryAgent);
    const expired = await expiryService.start(expiryActor);
    await database
      .update(personalAiDeviceFlows)
      .set({ expiresAt: new Date(now.getTime() - 1) })
      .where(eq(personalAiDeviceFlows.id, expired.flowId));
    await expect(
      expiryService.status(expiryActor, expired.flowId),
    ).resolves.toEqual({
      flowId: expired.flowId,
      state: "expired",
      expiresAt: new Date(now.getTime() - 1),
      retryable: true,
    });
    expect(expiryAgent.cancellations).toEqual([expired.flowId]);
  });

  test("recovers an orphaned durable collecting claim as retryable", async () => {
    const actorUserId = await actor("orphaned-claim");
    const agent = agentFixture();
    const service = serviceFor(agent);
    const started = await service.start(actorUserId);
    await database
      .update(personalAiDeviceFlows)
      .set({
        state: "collecting",
        updatedAt: new Date(now.getTime() - 2 * 60_000 - 1),
      })
      .where(eq(personalAiDeviceFlows.id, started.flowId));

    await expect(service.status(actorUserId, started.flowId)).resolves.toEqual({
      flowId: started.flowId,
      state: "failed",
      expiresAt,
      retryable: true,
    });
    expect(agent.cancellations).toEqual([started.flowId]);
    expect(agent.statuses).toEqual([]);
    expect(agent.collections).toEqual([]);
  });

  test("never reports completed after the credential is no longer live", async () => {
    const actorUserId = await actor("revoked");
    const agent = agentFixture();
    const service = serviceFor(agent);
    const started = await service.start(actorUserId);
    agent.state = "completed";
    await service.status(actorUserId, started.flowId);
    await database
      .update(credentials)
      .set({ revokedAt: new Date(now) })
      .where(
        and(
          eq(credentials.provider, "chatgpt"),
          eq(
            credentials.keyId,
            derivePersonalAiCredentialKeyId(actorUserId, "chatgpt"),
          ),
        ),
      );

    await expect(service.status(actorUserId, started.flowId)).resolves.toEqual({
      flowId: started.flowId,
      state: "failed",
      expiresAt,
      retryable: true,
    });
  });
});

describe("agent-codex device-auth protocol client", () => {
  test("uses only the fixed internal operation path and managed token", async () => {
    const requests: Request[] = [];
    const client = createChatGptDeviceAuthAgentClient({
      managedAgentEndpoint: "http://agent-codex:4202/ag-ui",
      managedAgentToken: "managed-token-canary",
      fetch: async (request) => {
        requests.push(request);
        return Response.json({
          flowId: "33333333-3333-4333-8333-333333333333",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGHJ",
          expiresAt: expiresAt.toISOString(),
        });
      },
      now: () => new Date(now),
    });

    const started = await client.start("33333333-3333-4333-8333-333333333333");

    expect(started.userCode).toBe("ABCD-EFGHJ");

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(
      "http://agent-codex:4202/internal/chatgpt-device-auth/start",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-openbot-agent-token")).toBe(
      "managed-token-canary",
    );
    expect(await request.json()).toEqual({
      flowId: "33333333-3333-4333-8333-333333333333",
    });
  });
});

describe("ChatGPT device-flow browser routes", () => {
  const actorA = {
    id: "route-actor-a",
    email: "route-a@example.test",
    role: "user",
  } as const satisfies AuthenticatedActor;
  const actorB = {
    id: "route-actor-b",
    email: "route-b@example.test",
    role: "user",
  } as const satisfies AuthenticatedActor;

  function appFor(input: {
    actor?: AuthenticatedActor | null;
    deviceFlows: ChatGptDeviceFlowService;
    store?: Parameters<typeof createPersonalAiConnectionRoutes>[0]["store"];
  }) {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      const currentActor = input.actor === undefined ? actorA : input.actor;
      if (!currentActor) {
        return context.json({ error: "Authentication required." }, 401);
      }
      context.set("actor", currentActor);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createPersonalAiConnectionRoutes({
        store: input.store ?? {
          status: async () => null,
          connect: async () => {
            throw new Error("not used");
          },
          disconnect: async () => null,
        },
        validator: { validate: async () => ({ ok: true, metadata: {} }) },
        requireUser,
        allowedOrigins: ["https://work.example.test"],
        deviceFlows: input.deviceFlows,
      }),
    );
    return app;
  }

  test("derives start/poll/cancel ownership only from the session actor", async () => {
    const calls: Array<{ operation: string; actor: string; flowId?: string }> =
      [];
    const flow = {
      flowId: "33333333-3333-4333-8333-333333333333",
      state: "pending" as const,
      expiresAt,
      retryable: false,
    };
    const service: ChatGptDeviceFlowService = {
      start: async (actorUserId) => {
        calls.push({ operation: "start", actor: actorUserId });
        return {
          ...flow,
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        };
      },
      status: async (actorUserId, flowId) => {
        calls.push({ operation: "status", actor: actorUserId, flowId });
        return flow;
      },
      cancel: async (actorUserId, flowId) => {
        calls.push({ operation: "cancel", actor: actorUserId, flowId });
        return { ...flow, state: "cancelled", retryable: true };
      },
      cancelInvalidated: async () => undefined,
    };
    const app = appFor({ actor: actorB, deviceFlows: service });
    const base =
      "https://work.example.test/api/ai-connections/chatgpt/device-flow";

    const start = await app.request(base, {
      method: "POST",
      headers: {
        origin: "https://work.example.test",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const status = await app.request(`${base}/${flow.flowId}`);
    const cancelled = await app.request(`${base}/${flow.flowId}`, {
      method: "DELETE",
      headers: { origin: "https://work.example.test" },
    });

    expect([start.status, status.status, cancelled.status]).toEqual([
      201, 200, 200,
    ]);
    expect(calls).toEqual([
      { operation: "start", actor: actorB.id },
      { operation: "status", actor: actorB.id, flowId: flow.flowId },
      { operation: "cancel", actor: actorB.id, flowId: flow.flowId },
    ]);
    const combined = `${await start.text()}${await status.text()}${await cancelled.text()}`;
    expect(combined).not.toContain("access-token-canary");
    expect(combined).not.toContain("authDocument");
  });

  test("routes connection replacement and disconnect invalidations only to the remote canceller", async () => {
    const flowIds = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ] as const;
    const cancellationBatches: string[][] = [];
    const service: ChatGptDeviceFlowService = {
      start: async () => {
        throw new Error("not used");
      },
      status: async () => {
        throw new Error("not used");
      },
      cancel: async () => {
        throw new Error("not used");
      },
      cancelInvalidated: async (invalidated) => {
        cancellationBatches.push([...invalidated]);
      },
    };
    const active = {
      provider: "openrouter" as const,
      state: "active" as const,
      validatedAt: now,
      disconnectedAt: null,
      updatedAt: now,
      safeMetadata: {},
    };
    const disconnected = {
      ...active,
      state: "disconnected" as const,
      disconnectedAt: now,
    };
    const app = appFor({
      deviceFlows: service,
      store: {
        status: async () => active,
        connect: async (_input, cancelInvalidated) => {
          await cancelInvalidated?.([flowIds[0]]);
          return active;
        },
        disconnect: async (_actorUserId, cancelInvalidated) => {
          await cancelInvalidated?.([flowIds[1]]);
          return disconnected;
        },
      },
    });
    const url = "https://work.example.test/api/ai-connections";

    const replaced = await app.request(url, {
      method: "PUT",
      headers: {
        origin: "https://work.example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "openrouter",
        apiKey: "sk-or-route-cancellation",
      }),
    });
    const deleted = await app.request(url, {
      method: "DELETE",
      headers: { origin: "https://work.example.test" },
    });

    expect([replaced.status, deleted.status]).toEqual([200, 200]);
    expect(cancellationBatches).toEqual([[flowIds[0]], [flowIds[1]]]);
    const responses = `${await replaced.text()}${await deleted.text()}`;
    expect(responses).not.toContain(flowIds[0]);
    expect(responses).not.toContain(flowIds[1]);
    expect(responses).not.toContain("cancelInvalidated");
  });

  test("authenticates before touching the flow service", async () => {
    const calls: string[] = [];
    const unavailable = async () => {
      calls.push("called");
      throw new Error("must not run");
    };
    const service: ChatGptDeviceFlowService = {
      start: unavailable,
      status: unavailable,
      cancel: unavailable,
      cancelInvalidated: unavailable,
    };
    const app = appFor({ actor: null, deviceFlows: service });
    const base =
      "https://work.example.test/api/ai-connections/chatgpt/device-flow";

    const responses = await Promise.all([
      app.request(base, {
        method: "POST",
        headers: {
          origin: "https://work.example.test",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      app.request(`${base}/33333333-3333-4333-8333-333333333333`),
      app.request(`${base}/33333333-3333-4333-8333-333333333333`, {
        method: "DELETE",
        headers: { origin: "https://work.example.test" },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401,
    ]);
    expect(calls).toEqual([]);
  });

  test("rejects query, origin and body smuggling before calling the service", async () => {
    const calls: string[] = [];
    const unavailable = async () => {
      calls.push("called");
      throw new Error("must not run");
    };
    const service: ChatGptDeviceFlowService = {
      start: unavailable,
      status: unavailable,
      cancel: unavailable,
      cancelInvalidated: unavailable,
    };
    const app = appFor({ deviceFlows: service });
    const base =
      "https://work.example.test/api/ai-connections/chatgpt/device-flow";
    const flowPath = `${base}/33333333-3333-4333-8333-333333333333`;

    const query = await app.request(`${base}?actor=${actorB.id}`, {
      method: "POST",
      headers: {
        origin: "https://work.example.test",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const origin = await app.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const extraBody = await app.request(base, {
      method: "POST",
      headers: {
        origin: "https://work.example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ actor: actorB.id }),
    });
    const pollQuery = await app.request(`${flowPath}?actor=${actorB.id}`);
    const cancelBody = await app.request(flowPath, {
      method: "DELETE",
      headers: { origin: "https://work.example.test" },
      body: "{}",
    });

    expect(
      [query, origin, extraBody, pollQuery, cancelBody].map(
        (response) => response.status,
      ),
    ).toEqual([400, 403, 400, 400, 400]);
    expect(calls).toEqual([]);
  });

  test("returns one generic refusal for foreign and unknown flow ids", async () => {
    const service: ChatGptDeviceFlowService = {
      start: async () => {
        throw new ChatGptDeviceFlowUnavailableError();
      },
      status: async () => {
        throw new ChatGptDeviceFlowUnavailableError();
      },
      cancel: async () => {
        throw new ChatGptDeviceFlowUnavailableError();
      },
      cancelInvalidated: async () => undefined,
    };
    const app = appFor({ deviceFlows: service });
    const base =
      "https://work.example.test/api/ai-connections/chatgpt/device-flow";
    const foreign = await app.request(
      `${base}/33333333-3333-4333-8333-333333333333`,
    );
    const unknown = await app.request(
      `${base}/44444444-4444-4444-8444-444444444444`,
    );

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(foreign.headers.get("cache-control")).toBe("private, no-store");
  });
});
