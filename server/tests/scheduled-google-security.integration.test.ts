import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ChannelStore } from "../src/channels/routes";
import type { ActionPolicy } from "../src/computer/policy";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  credentials,
  googleAppendOperations,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import { createPluginStore, TokenRefusedError } from "../src/plugins/store";
import { createRoutineRunner } from "../src/routines/runner";
import type { RoutineRunOutcome, RoutineStore } from "../src/routines/store";
import { TEST_POOL } from "./support/database";

/**
 * A scheduled Google write through the same boundary as an interactive tool call.
 *
 * The model and Google are deliberately absent. The routine runner supplies the owner identity from
 * its stored run context, and the injected turn calls the real PluginStore with that identity. Only
 * the OAuth exchange and Google request are fakes. This leaves the boundaries this stage exists to
 * prove real: exact Bot grant, current per-user OAuth row and scopes, action policy, durable append
 * claim, and content-free audit.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const ownerId = `user_scheduled_google_${suite}`;
const botId = `agent_scheduled_google_${suite}`;
const serverId = "google-drive";
const docTool = "append_google_doc";
const sheetTool = "append_google_sheet_rows";
const docRef = `${serverId}/${docTool}`;
const sheetRef = `${serverId}/${sheetTool}`;
const refs = [docRef, sheetRef] as const;
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CLIENT = {
  clientId: `scheduled-google-client-${suite}`,
  clientSecret: `scheduled-google-client-secret-${suite}`,
};
const FULL_SCOPE = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ");
const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const REFRESH_TOKEN = `scheduled-google-refresh-${suite}`;
const ACCESS_TOKEN = `scheduled-google-access-${suite}`;

const DOC_CONTENT = `DOC_CONTENT_MUST_NOT_REACH_AUDIT_${suite}`;
const SHEET_CONTENT = `SHEET_CELL_MUST_NOT_REACH_AUDIT_${suite}`;
const DOC_ID = `scheduled_doc_${suite}`;
const SHEET_ID = `scheduled_sheet_${suite}`;
const SHEET_NAME = `PrivateLedger_${suite}`;

let policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
let exchangeMode: "success" | "expired" = "success";
const credentialIds: string[] = [];
const exchanged: string[] = [];
const vendorCalls: {
  toolName: string;
  token?: string;
  args: Record<string, unknown>;
}[] = [];

let serverExisted = false;
let clientBefore: string | null = null;
const toolExisted = new Map<string, boolean>();

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    async readSecret(id) {
      const [row] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, id));
      return row ?? null;
    },
    async create() {
      throw new Error("scheduled Google fixtures write credentials directly");
    },
    async updateSecret() {
      throw new Error("scheduled Google fixtures do not rotate credentials");
    },
    async revoke(id) {
      const revokedAt = new Date();
      await database
        .update(credentials)
        .set({ revokedAt, updatedAt: revokedAt })
        .where(eq(credentials.id, id));
      return revokedAt;
    },
  },
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  async exchangeRefreshToken({ refreshToken }) {
    exchanged.push(refreshToken);
    if (exchangeMode === "expired") {
      throw new TokenRefusedError(
        "The fake OAuth grant has expired.",
        "invalid_grant",
      );
    }
    return { accessToken: ACCESS_TOKEN };
  },
  async callVendor(connection, toolName, args) {
    vendorCalls.push({ toolName, token: connection.token, args });
    return {
      text: `${toolName} was accepted by the fake Google boundary.`,
      isError: false,
      externalEffect: "applied",
    };
  },
});

async function connect(scope: string): Promise<string> {
  const revokedAt = new Date();
  await database
    .update(credentials)
    .set({ revokedAt, updatedAt: revokedAt })
    .where(
      and(
        eq(credentials.kind, "mcp_user_token"),
        eq(credentials.provider, serverId),
        eq(credentials.keyId, ownerId),
        isNull(credentials.revokedAt),
      ),
    );

  const [credential] = await database
    .insert(credentials)
    .values({
      kind: "mcp_user_token",
      provider: serverId,
      keyId: ownerId,
      metadata: {},
      encryptedValue: await encryptSecret(ENCRYPTION_KEY, REFRESH_TOKEN),
    })
    .returning({ id: credentials.id });
  if (!credential)
    throw new Error("the fake user OAuth credential was not stored");
  credentialIds.push(credential.id);

  await database.insert(mcpUserCredentials).values({
    serverId,
    userId: ownerId,
    credentialId: credential.id,
    scope,
  });
  return credential.id;
}

type FinishedRun = {
  status: RoutineRunOutcome;
  error?: string;
};

async function fireScheduled(input: {
  ref: string;
  args: Record<string, unknown>;
  name: string;
}): Promise<FinishedRun> {
  const routineRunId = `routine_run_${input.name}_${suite}`;
  const routineId = `routine_${input.name}_${suite}`;
  const channelId = `channel_${input.name}_${suite}`;
  const threadId = `thread_${input.name}_${suite}`;
  let finished: FinishedRun | null = null;

  const routineStore = {
    async runContext(runId: string) {
      expect(runId).toBe(routineRunId);
      return {
        routineId,
        ownerUserId: ownerId,
        agentId: botId,
        channelId,
        instruction: `Run ${input.ref}.`,
      };
    },
    async finishRun(runId: string, status: RoutineRunOutcome, error?: string) {
      expect(runId).toBe(routineRunId);
      finished = { status, error };
    },
    async consecutiveFailures(id: string) {
      expect(id).toBe(routineId);
      return 1;
    },
    async setEnabled() {
      throw new Error(
        "one failed fixture run must not reach the fatigue limit",
      );
    },
  } as unknown as RoutineStore;

  const channelStore = {
    async get(actor: { id: string }, requestedChannelId: string) {
      expect(actor.id).toBe(ownerId);
      expect(requestedChannelId).toBe(channelId);
      return {
        id: channelId,
        name: "Scheduled Google security",
        agentIds: [botId],
        threadId,
        active: true,
      };
    },
    async recordActivity(actor: { id: string }, requestedChannelId: string) {
      expect(actor.id).toBe(ownerId);
      expect(requestedChannelId).toBe(channelId);
    },
  } as unknown as ChannelStore;

  const runner = createRoutineRunner({
    routineStore,
    channelStore,
    runTurn: async ({ ownerUserId, agentId, threadId: currentThreadId }) => {
      expect(ownerUserId).toBe(ownerId);
      expect(agentId).toBe(botId);
      expect(currentThreadId).toBe(threadId);
      const result = await store.callTool({
        ref: input.ref,
        args: input.args,
        actorId: ownerUserId,
        botId: agentId,
        runId: `agent_run_${input.name}_${suite}`,
        threadId: currentThreadId,
      });
      return { replyText: result.text };
    },
  });

  await runner.run(routineRunId);
  if (!finished)
    throw new Error("the scheduled fixture did not finish its run");
  return finished;
}

async function grant(ref: string): Promise<void> {
  await store.grant("mcp", ref, botId, `fixture-admin-${suite}`);
}

async function auditIdsFor(ref: string): Promise<Set<string>> {
  const rows = await database
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "mcp_tool"),
        eq(auditEvents.targetId, ref),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

async function newCallAuditRows(ref: string, before: Set<string>) {
  const rows = await database
    .select({
      id: auditEvents.id,
      eventType: auditEvents.eventType,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "mcp_tool"),
        eq(auditEvents.targetId, ref),
      ),
    );
  return rows.filter((row) => {
    const payload = row.payload as { actor?: string };
    return (
      !before.has(row.id) &&
      row.eventType.startsWith("mcp.call_") &&
      payload.actor === ownerId
    );
  });
}

beforeAll(async () => {
  await database.insert(users).values({
    id: ownerId,
    email: `${ownerId}@openbot.test`,
    name: ownerId,
    emailVerified: false,
  });
  await database.insert(agents).values({
    id: botId,
    name: botId,
    type: "remote_ag_ui",
    configuration: {},
  });

  const [server] = await database
    .select({ credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  serverExisted = server !== undefined;
  clientBefore = server?.credentialId ?? null;

  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Google Workspace",
      vendor: "Google",
      url: "https://www.googleapis.com/drive/v3",
      provenance: "first-party",
    })
    .onConflictDoNothing();

  for (const toolName of [docTool, sheetTool]) {
    const [tool] = await database
      .select({ name: mcpTools.name })
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
    toolExisted.set(toolName, tool !== undefined);
    await database
      .insert(mcpTools)
      .values({ serverId, name: toolName, description: "Fixture write." })
      .onConflictDoNothing();
  }

  const [client] = await database
    .insert(credentials)
    .values({
      kind: "mcp_oauth_client",
      provider: serverId,
      keyId: `scheduled-google-client-${suite}`,
      metadata: { clientId: CLIENT.clientId },
      encryptedValue: await encryptSecret(
        ENCRYPTION_KEY,
        JSON.stringify(CLIENT),
      ),
    })
    .returning({ id: credentials.id });
  if (!client) throw new Error("the fake OAuth client was not stored");
  credentialIds.push(client.id);
  await database
    .update(mcpServers)
    .set({ credentialId: client.id })
    .where(eq(mcpServers.id, serverId));
});

beforeEach(async () => {
  policy = { mode: "enforce", deny: [], allow: ["true"] };
  exchangeMode = "success";
  exchanged.length = 0;
  vendorCalls.length = 0;
  await database
    .delete(mcpUserCredentials)
    .where(
      and(
        eq(mcpUserCredentials.serverId, serverId),
        eq(mcpUserCredentials.userId, ownerId),
      ),
    );
  await database
    .delete(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, "mcp"),
        inArray(pluginGrants.ref, refs),
        eq(pluginGrants.agentId, botId),
      ),
    );
});

afterAll(async () => {
  await database
    .delete(mcpUserCredentials)
    .where(eq(mcpUserCredentials.userId, ownerId));
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database
    .delete(googleAppendOperations)
    .where(eq(googleAppendOperations.botId, botId));

  if (serverExisted) {
    await database
      .update(mcpServers)
      .set({ credentialId: clientBefore })
      .where(eq(mcpServers.id, serverId));
    for (const toolName of [docTool, sheetTool]) {
      if (toolExisted.get(toolName)) continue;
      await database
        .delete(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        );
    }
  } else {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }

  if (credentialIds.length > 0) {
    await database
      .delete(credentials)
      .where(inArray(credentials.id, credentialIds));
  }
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, ownerId));
});

describe("scheduled Google writes use the interactive security boundary", () => {
  test("Docs and Sheets succeed with the owner's current OAuth, exact grants and policy", async () => {
    await connect(FULL_SCOPE);
    await grant(docRef);
    await grant(sheetRef);
    const beforeDoc = await auditIdsFor(docRef);
    const beforeSheet = await auditIdsFor(sheetRef);

    const docRun = await fireScheduled({
      ref: docRef,
      name: "success_doc",
      args: { documentId: DOC_ID, text: DOC_CONTENT },
    });
    const sheetRun = await fireScheduled({
      ref: sheetRef,
      name: "success_sheet",
      args: {
        spreadsheetId: SHEET_ID,
        sheetName: SHEET_NAME,
        rows: [[SHEET_CONTENT, 7]],
      },
    });

    expect(docRun.status).toBe("succeeded");
    expect(sheetRun.status).toBe("succeeded");
    expect(exchanged).toEqual([REFRESH_TOKEN, REFRESH_TOKEN]);
    expect(vendorCalls.map((call) => call.toolName)).toEqual([
      docTool,
      sheetTool,
    ]);
    expect(vendorCalls.every((call) => call.token === ACCESS_TOKEN)).toBe(true);

    const audits = [
      ...(await newCallAuditRows(docRef, beforeDoc)),
      ...(await newCallAuditRows(sheetRef, beforeSheet)),
    ];
    expect(audits.map((row) => row.eventType)).toEqual([
      "mcp.call_succeeded",
      "mcp.call_succeeded",
    ]);
    expect(
      audits.map((row) => {
        const payload = row.payload as {
          reachedAs?: string;
          effect?: string;
          operation?: { targetId?: string };
        };
        return {
          reachedAs: payload.reachedAs,
          effect: payload.effect,
          targetId: payload.operation?.targetId,
        };
      }),
    ).toEqual([
      { reachedAs: ownerId, effect: "write", targetId: DOC_ID },
      { reachedAs: ownerId, effect: "write", targetId: SHEET_ID },
    ]);

    const auditJson = JSON.stringify(audits);
    expect(auditJson).not.toContain(DOC_CONTENT);
    expect(auditJson).not.toContain(SHEET_CONTENT);
    expect(auditJson).not.toContain(SHEET_NAME);
    expect(auditJson).not.toContain(REFRESH_TOKEN);
    expect(auditJson).not.toContain(ACCESS_TOKEN);
  });

  test("missing OAuth fails the routine before token exchange or Google", async () => {
    await grant(docRef);
    const before = await auditIdsFor(docRef);

    const run = await fireScheduled({
      ref: docRef,
      name: "missing_oauth",
      args: { documentId: DOC_ID, text: DOC_CONTENT },
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("not connected");
    expect(exchanged).toEqual([]);
    expect(vendorCalls).toEqual([]);
    const audits = await newCallAuditRows(docRef, before);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("mcp.call_failed");
    expect(JSON.stringify(audits)).not.toContain(DOC_CONTENT);
  });

  test("an expired OAuth grant fails the routine and never reaches Google", async () => {
    await connect(FULL_SCOPE);
    await grant(sheetRef);
    exchangeMode = "expired";
    const before = await auditIdsFor(sheetRef);

    const run = await fireScheduled({
      ref: sheetRef,
      name: "expired_oauth",
      args: {
        spreadsheetId: SHEET_ID,
        sheetName: SHEET_NAME,
        rows: [[SHEET_CONTENT]],
      },
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("expired");
    expect(exchanged).toEqual([REFRESH_TOKEN]);
    expect(vendorCalls).toEqual([]);
    const audits = await newCallAuditRows(sheetRef, before);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("mcp.call_failed");
    expect(JSON.stringify(audits)).not.toContain(SHEET_CONTENT);
  });

  test("a grant for Docs does not widen to the Sheets tool", async () => {
    await connect(FULL_SCOPE);
    await grant(docRef);
    const before = await auditIdsFor(sheetRef);

    const run = await fireScheduled({
      ref: sheetRef,
      name: "exact_grant",
      args: {
        spreadsheetId: SHEET_ID,
        sheetName: SHEET_NAME,
        rows: [[SHEET_CONTENT]],
      },
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain(sheetRef);
    expect(exchanged).toEqual([]);
    expect(vendorCalls).toEqual([]);
    const audits = await newCallAuditRows(sheetRef, before);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("mcp.call_rejected");
    const payload = audits[0]?.payload as { refusal?: string } | undefined;
    expect(payload?.refusal).toBe("not_granted");
  });

  test("a revoked exact grant stays revoked for a scheduled firing", async () => {
    await connect(FULL_SCOPE);
    await grant(docRef);
    await store.revoke("mcp", docRef, botId, `fixture-admin-${suite}`);

    const run = await fireScheduled({
      ref: docRef,
      name: "revoked_grant",
      args: { documentId: DOC_ID, text: DOC_CONTENT },
    });

    expect(run.status).toBe("failed");
    expect(exchanged).toEqual([]);
    expect(vendorCalls).toEqual([]);
  });

  test("a read-only OAuth connection cannot perform a scheduled write", async () => {
    await connect(READ_ONLY_SCOPE);
    await grant(docRef);
    const before = await auditIdsFor(docRef);

    const run = await fireScheduled({
      ref: docRef,
      name: "read_only_scope",
      args: { documentId: DOC_ID, text: DOC_CONTENT },
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Reconnect");
    expect(exchanged).toEqual([]);
    expect(vendorCalls).toEqual([]);
    const audits = await newCallAuditRows(docRef, before);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("mcp.call_failed");
    expect(JSON.stringify(audits)).not.toContain(DOC_CONTENT);
  });

  test("policy denial stops a scheduled write before OAuth or Google", async () => {
    await connect(FULL_SCOPE);
    await grant(sheetRef);
    policy = {
      mode: "enforce",
      deny: ['mcp.server == "google-drive" && intent == "write_tool"'],
      allow: ["true"],
    };
    const before = await auditIdsFor(sheetRef);

    const run = await fireScheduled({
      ref: sheetRef,
      name: "policy_deny",
      args: {
        spreadsheetId: SHEET_ID,
        sheetName: SHEET_NAME,
        rows: [[SHEET_CONTENT]],
      },
    });

    expect(run.status).toBe("failed");
    expect(exchanged).toEqual([]);
    expect(vendorCalls).toEqual([]);
    const audits = await newCallAuditRows(sheetRef, before);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("mcp.call_rejected");
    const payload = audits[0]?.payload as
      | { decision?: { allowed?: boolean } }
      | undefined;
    expect(payload?.decision?.allowed).toBe(false);
    expect(JSON.stringify(audits)).not.toContain(SHEET_CONTENT);
  });
});
