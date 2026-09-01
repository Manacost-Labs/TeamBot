import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import {
  authoriseAgentCall,
  readRunAssertion,
} from "../src/agents/callback-token";
import {
  createPersonalAiCredentialInternalRoutes,
  PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH,
} from "../src/ai-connections/internal-routes";
import { createPersonalAiCredentialLeaseService } from "../src/ai-connections/leases";
import { createPersonalAiRunGovernorForActor } from "../src/ai-connections/run-delivery";
import {
  createPersonalAiConnectionStore,
  derivePersonalAiCredentialKeyId,
} from "../src/ai-connections/store";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  credentials,
  personalAiCredentialLeases,
  userAiConnections,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const managedAgentToken = "task-21-managed-agent-token";
const legacyToolToken = "task-21-governed-tool-token";
const managedEndpoint = "http://agent-codex:4202/ag-ui";
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);
const createdActorIds: string[] = [];
const createdBotIds: string[] = [];

type ActorFixture = Readonly<{
  id: string;
  name: string;
  key: string;
}>;

async function createActor(label: string): Promise<ActorFixture> {
  const id = `personal-run-${label}-${randomUUID()}`;
  const key = `task21-${label}-secret-canary-${randomUUID()}`;
  createdActorIds.push(id);
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: `Task 21 ${label}`,
  });
  return { id, name: `Task 21 ${label}`, key };
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

afterEach(async () => {
  if (createdBotIds.length > 0) {
    await database
      .delete(agents)
      .where(inArray(agents.id, createdBotIds.splice(0)));
  }
  if (createdActorIds.length > 0) {
    const actorIds = createdActorIds.splice(0);
    await database
      .delete(userAiConnections)
      .where(inArray(userAiConnections.userId, actorIds));
    await database.delete(credentials).where(
      inArray(
        credentials.keyId,
        actorIds.map((id) => derivePersonalAiCredentialKeyId(id, "openrouter")),
      ),
    );
    await database.delete(users).where(inArray(users.id, actorIds));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("two actors using one managed employee", () => {
  test("uses each authenticated actor id for a separate Intelligence history read", async () => {
    const previousTelemetrySetting = process.env.COPILOTKIT_TELEMETRY_DISABLED;
    process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const intelligence = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push({
          url: request.url,
          method: request.method,
          body: await request.text(),
        });
        return Response.json({ messages: [] });
      },
    });
    try {
      const apiUrl = `http://127.0.0.1:${intelligence.port}`;
      const config = loadConfig(
        testEnvironment({
          INTELLIGENCE_API_URL: apiUrl,
          INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${intelligence.port}`,
          KEY_ENCRYPTION_KEY: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=",
        }),
      );
      const runtime = mountCopilotRuntime(
        config,
        { provider: "openai", defaultModel: "unused" },
        async () => [],
        async () => null,
        async () => ({ id: "unused", name: "Unused" }),
        async () => ({ id: "unused", role: "user" }),
        {
          watch: () => globalThis.fetch,
          stop: () => undefined,
        },
      );

      await Promise.all([
        runtime.history({
          threadId: "shared-logical-thread",
          actorId: "intelligence-actor-first",
        }),
        runtime.history({
          threadId: "shared-logical-thread",
          actorId: "intelligence-actor-second",
        }),
      ]);

      expect(requests).toHaveLength(2);
      const encoded = requests.map(({ url, body }) => `${url}\n${body}`);
      expect(
        encoded.filter((value) => value.includes("intelligence-actor-first")),
      ).toHaveLength(1);
      expect(
        encoded.filter((value) => value.includes("intelligence-actor-second")),
      ).toHaveLength(1);
      expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
    } finally {
      intelligence.stop(true);
      if (previousTelemetrySetting === undefined) {
        delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
      } else {
        process.env.COPILOTKIT_TELEMETRY_DISABLED = previousTelemetrySetting;
      }
    }
  });

  test("keeps Intelligence identity, leases, provider contexts and audit actors distinct", async () => {
    const first = await createActor("first");
    const second = await createActor("second");
    const botId = `personal-run-bot-${randomUUID()}`;
    createdBotIds.push(botId);
    await database.insert(agents).values({
      id: botId,
      name: "Shared research employee",
      type: "remote_ag_ui",
      configuration: { endpoint: managedEndpoint },
    });

    const consoleRows: unknown[][] = [];
    const consoleSpies = [
      spyOn(console, "log").mockImplementation((...values) =>
        consoleRows.push(values),
      ),
      spyOn(console, "warn").mockImplementation((...values) =>
        consoleRows.push(values),
      ),
      spyOn(console, "error").mockImplementation((...values) =>
        consoleRows.push(values),
      ),
    ];

    try {
      const connections = createPersonalAiConnectionStore({
        database,
        encryptionKey,
      });
      await Promise.all(
        [first, second].map((actor) =>
          connections.connect({
            actorUserId: actor.id,
            provider: "openrouter",
            plaintext: actor.key,
            safeMetadata: {},
          }),
        ),
      );

      const leases = createPersonalAiCredentialLeaseService({
        database,
        encryptionKey,
      });
      const runIds = [`run-${randomUUID()}`, `run-${randomUUID()}`];
      const actors = [first, second] as const;
      const governed = await Promise.all(
        actors.map((actor, index) =>
          createPersonalAiRunGovernorForActor({
            actorUserId: actor.id,
            encryptionKey,
            managedAgentEndpoint: managedEndpoint,
            leases,
          })({
            botId,
            endpoint: managedEndpoint,
            runId: runIds[index]!,
            threadId: `thread-${actor.id}`,
            forwardedProps: {
              openbotRun: "browser-forgery",
              openbotCredentialLease: "browser-forgery",
              openbotAdmissionKey: "browser-forgery",
            },
          }),
        ),
      );
      const assertions = governed.map((run) =>
        readRunAssertion(run?.openbotRun, encryptionKey),
      );

      // The runtime projects this same authenticated id to Intelligence. Distinct ids mean the
      // shared logical employee receives two thread/history namespaces rather than one shared one.
      const intelligenceUsers = actors.map(({ id, name }) => ({ id, name }));
      expect(new Set(intelligenceUsers.map(({ id }) => id)).size).toBe(2);
      expect(assertions.map((assertion) => assertion?.actorId)).toEqual(
        intelligenceUsers.map(({ id }) => id),
      );
      expect(assertions.map((assertion) => assertion?.botId)).toEqual([
        botId,
        botId,
      ]);
      expect(governed[0]?.openbotCredentialLease).not.toBe(
        governed[1]?.openbotCredentialLease,
      );
      expect(governed[0]?.openbotAdmissionKey).not.toBe(
        governed[1]?.openbotAdmissionKey,
      );

      const leaseRows = await database
        .select({
          id: personalAiCredentialLeases.id,
          userId: personalAiCredentialLeases.userId,
          runId: personalAiCredentialLeases.runId,
        })
        .from(personalAiCredentialLeases)
        .where(
          inArray(
            personalAiCredentialLeases.id,
            governed.map((run) => run!.openbotCredentialLease),
          ),
        );
      expect(new Set(leaseRows.map(({ id }) => id)).size).toBe(2);
      expect(new Set(leaseRows.map(({ userId }) => userId))).toEqual(
        new Set(actors.map(({ id }) => id)),
      );
      expect(new Set(leaseRows.map(({ runId }) => runId))).toEqual(
        new Set(runIds),
      );

      const app = internalApp(leases);
      const providerContexts = await Promise.all(
        governed.map(async (run) => {
          const response = await app.request(
            `http://openbot.test${PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-openbot-agent-token": managedAgentToken,
              },
              body: JSON.stringify({
                lease: run!.openbotCredentialLease,
                run: run!.openbotRun,
              }),
            },
          );
          expect(response.status).toBe(200);
          return (await response.json()) as {
            provider: string;
            apiKey: string;
          };
        }),
      );
      expect(providerContexts.map(({ provider }) => provider)).toEqual([
        "openrouter",
        "openrouter",
      ]);
      expect(providerContexts[0]?.apiKey === first.key).toBe(true);
      expect(providerContexts[1]?.apiKey === second.key).toBe(true);
      expect(providerContexts[0]?.apiKey === providerContexts[1]?.apiKey).toBe(
        false,
      );

      const auditRows = await database
        .select({
          actorUserId: auditEvents.actorUserId,
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          inArray(
            auditEvents.actorUserId,
            actors.map(({ id }) => id),
          ),
        );
      expect(
        auditRows
          .filter(
            ({ eventType }) => eventType === "personal_ai_connection.connected",
          )
          .map(({ actorUserId }) => actorUserId)
          .sort(),
      ).toEqual(actors.map(({ id }) => id).sort());

      // These are the only browser-safe values produced by the server-side slice. The plaintext
      // contexts above exist solely on the authenticated internal route.
      const browserProjection = JSON.stringify({
        connectionStatuses: await Promise.all(
          actors.map(({ id }) => connections.status(id)),
        ),
        governed,
        auditRows,
      });
      const boundedLogs = JSON.stringify(consoleRows);
      expect(browserProjection.includes(first.key)).toBe(false);
      expect(browserProjection.includes(second.key)).toBe(false);
      expect(boundedLogs.includes(first.key)).toBe(false);
      expect(boundedLogs.includes(second.key)).toBe(false);
      expect(boundedLogs.length).toBeLessThan(16_384);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  test("authorizes governed tools from the original signed run, not provider output", async () => {
    const actorId = `signed-actor-${randomUUID()}`;
    const botId = `signed-bot-${randomUUID()}`;
    const runId = `signed-run-${randomUUID()}`;
    const leases = {
      mint: async () => "00000000-0000-4000-8000-000000000021",
    };
    const governed = await createPersonalAiRunGovernorForActor({
      actorUserId: actorId,
      encryptionKey,
      managedAgentEndpoint: managedEndpoint,
      leases,
    })({
      botId,
      endpoint: managedEndpoint,
      runId,
      threadId: "signed-thread",
      forwardedProps: {},
    });
    const providerOutput = {
      actorId: "forged-output-actor",
      botId: "forged-output-bot",
      runId: "forged-output-run",
      run: "forged-output-assertion",
    };

    const verdict = await authoriseAgentCall({
      presented: legacyToolToken,
      run: governed?.openbotRun,
      encryptionKey,
      legacyToken: legacyToolToken,
      lookup: async () => null,
    });
    expect(verdict).toEqual({
      ok: true,
      actorId,
      botId,
      runId,
      threadId: "signed-thread",
      depth: 0,
    });
    expect(verdict.ok && verdict.actorId).not.toBe(providerOutput.actorId);
    expect(verdict.ok && verdict.botId).not.toBe(providerOutput.botId);
    expect(verdict.ok && verdict.runId).not.toBe(providerOutput.runId);

    const forgedVerdict = await authoriseAgentCall({
      presented: legacyToolToken,
      run: providerOutput.run,
      encryptionKey,
      legacyToken: legacyToolToken,
      lookup: async () => null,
    });
    expect(forgedVerdict).toEqual({
      ok: false,
      status: 401,
      reason: "Not authorised.",
    });
  });
});
