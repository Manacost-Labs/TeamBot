import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  credentials,
  personalAiDeviceFlows,
  userAiConnections,
} from "../db/schema";
import {
  type createPersonalAiConnectionStore,
  lockPersonalAiActor,
} from "./store";

const AGENT_PATHS = Object.freeze({
  start: "/internal/chatgpt-device-auth/start",
  status: "/internal/chatgpt-device-auth/status",
  cancel: "/internal/chatgpt-device-auth/cancel",
  collect: "/internal/chatgpt-device-auth/collect",
});
const DEFAULT_FLOW_TTL_MS = 15 * 60_000;
const COLLECTING_STALE_MS = 2 * 60_000;
const MAX_AGENT_RESPONSE_BYTES = 300 * 1_024;
const MAX_AUTH_DOCUMENT_BYTES = 256 * 1_024;
const MAX_TOKEN_CHARACTERS = 192 * 1_024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_CODE = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4,5}){1,3}$/;
const FLOW_STATES = new Set([
  "pending",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export type ChatGptDeviceFlowState =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ChatGptDeviceFlowStatus = Readonly<{
  flowId: string;
  state: ChatGptDeviceFlowState;
  expiresAt: Date;
  retryable: boolean;
}>;

export type ChatGptDeviceFlowStart = ChatGptDeviceFlowStatus &
  Readonly<{
    verificationUrl: string;
    userCode: string;
  }>;

export type ChatGptDeviceAuthAgent = Readonly<{
  start(flowId: string): Promise<ChatGptDeviceFlowStart>;
  status(flowId: string): Promise<ChatGptDeviceFlowStatus>;
  cancel(flowId: string): Promise<ChatGptDeviceFlowStatus>;
  collect(
    flowId: string,
  ): Promise<Readonly<{ provider: "chatgpt"; authDocument: string }>>;
}>;

export type ChatGptDeviceFlowService = Readonly<{
  start(actorUserId: string): Promise<ChatGptDeviceFlowStart>;
  status(actorUserId: string, flowId: string): Promise<ChatGptDeviceFlowStatus>;
  cancel(actorUserId: string, flowId: string): Promise<ChatGptDeviceFlowStatus>;
  cancelInvalidated(flowIds: readonly string[]): Promise<void>;
}>;

export class ChatGptDeviceFlowUnavailableError extends Error {
  constructor() {
    super("ChatGPT device flow is unavailable.");
    this.name = "ChatGptDeviceFlowUnavailableError";
  }
}

export class ChatGptDeviceFlowServiceUnavailableError extends Error {
  constructor() {
    super("ChatGPT device flow service is temporarily unavailable.");
    this.name = "ChatGptDeviceFlowServiceUnavailableError";
  }
}

class AgentProtocolError extends Error {
  constructor() {
    super("Managed device authentication is unavailable.");
    this.name = "AgentProtocolError";
  }
}

type ConnectionStore = Pick<
  ReturnType<typeof createPersonalAiConnectionStore>,
  "connectPrepared" | "prepareConnection"
>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type FlowRow = typeof personalAiDeviceFlows.$inferSelect;

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : undefined;
}

function canonicalFlowId(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : undefined;
}

function parseAgentStatus(
  value: unknown,
  expectedFlowId: string,
  now: Date,
): ChatGptDeviceFlowStatus {
  const body = objectValue(value);
  if (
    !body ||
    !exactKeys(body, ["expiresAt", "flowId", "state"]) ||
    canonicalFlowId(body.flowId) !== expectedFlowId ||
    typeof body.state !== "string" ||
    !FLOW_STATES.has(body.state)
  ) {
    throw new AgentProtocolError();
  }
  const expiresAt = canonicalDate(body.expiresAt);
  const state = body.state as ChatGptDeviceFlowState;
  if (
    !expiresAt ||
    expiresAt.getTime() > now.getTime() + 20 * 60_000 ||
    (state === "pending" && expiresAt <= now)
  ) {
    throw new AgentProtocolError();
  }
  return {
    flowId: expectedFlowId,
    state,
    expiresAt,
    retryable: state !== "pending" && state !== "completed",
  };
}

function parseAgentStart(
  value: unknown,
  expectedFlowId: string,
  now: Date,
): ChatGptDeviceFlowStart {
  const body = objectValue(value);
  if (
    !body ||
    !exactKeys(body, ["expiresAt", "flowId", "userCode", "verificationUrl"]) ||
    canonicalFlowId(body.flowId) !== expectedFlowId ||
    typeof body.verificationUrl !== "string" ||
    typeof body.userCode !== "string" ||
    !USER_CODE.test(body.userCode)
  ) {
    throw new AgentProtocolError();
  }
  let verificationUrl: URL;
  try {
    verificationUrl = new URL(body.verificationUrl);
  } catch {
    throw new AgentProtocolError();
  }
  const expiresAt = canonicalDate(body.expiresAt);
  if (
    verificationUrl.href !== "https://auth.openai.com/codex/device" ||
    !expiresAt ||
    expiresAt <= now ||
    expiresAt.getTime() > now.getTime() + 20 * 60_000
  ) {
    throw new AgentProtocolError();
  }
  return {
    flowId: expectedFlowId,
    state: "pending",
    expiresAt,
    retryable: false,
    verificationUrl: verificationUrl.href,
    userCode: body.userCode,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AgentProtocolError();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_AGENT_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AgentProtocolError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AgentProtocolError();
  }
}

/** Fixed private client for Task 22's managed-token device-auth boundary. */
export function createChatGptDeviceAuthAgentClient(input: {
  managedAgentEndpoint: string;
  managedAgentToken: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): ChatGptDeviceAuthAgent {
  let endpoint: URL;
  try {
    endpoint = new URL(input.managedAgentEndpoint);
  } catch {
    throw new Error("Managed agent endpoint is invalid.");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.pathname !== "/ag-ui" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    throw new Error("Managed agent endpoint is invalid.");
  }
  const token = input.managedAgentToken.trim();
  if (!token) throw new Error("Managed agent token is required.");
  const fetchImpl = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Managed device authentication timeout is invalid.");
  }

  async function operation(path: string, flowId: string) {
    const canonical = canonicalFlowId(flowId);
    if (!canonical) throw new AgentProtocolError();
    const request = new Request(new URL(path, endpoint.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": token,
      },
      body: JSON.stringify({ flowId: canonical }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let response: Response;
    try {
      response = await fetchImpl(request, { redirect: "error" });
    } catch {
      throw new AgentProtocolError();
    }
    if (!response.ok) throw new AgentProtocolError();
    return boundedJson(response);
  }

  return Object.freeze({
    async start(flowId) {
      const canonical = canonicalFlowId(flowId);
      if (!canonical) throw new AgentProtocolError();
      return parseAgentStart(
        await operation(AGENT_PATHS.start, canonical),
        canonical,
        now(),
      );
    },
    async status(flowId) {
      const canonical = canonicalFlowId(flowId);
      if (!canonical) throw new AgentProtocolError();
      return parseAgentStatus(
        await operation(AGENT_PATHS.status, canonical),
        canonical,
        now(),
      );
    },
    async cancel(flowId) {
      const canonical = canonicalFlowId(flowId);
      if (!canonical) throw new AgentProtocolError();
      return parseAgentStatus(
        await operation(AGENT_PATHS.cancel, canonical),
        canonical,
        now(),
      );
    },
    async collect(flowId) {
      const canonical = canonicalFlowId(flowId);
      if (!canonical) throw new AgentProtocolError();
      const body = objectValue(await operation(AGENT_PATHS.collect, canonical));
      if (
        !body ||
        !exactKeys(body, ["authDocument", "provider"]) ||
        body.provider !== "chatgpt" ||
        typeof body.authDocument !== "string"
      ) {
        throw new AgentProtocolError();
      }
      return { provider: "chatgpt", authDocument: body.authDocument };
    },
  });
}

function boundedActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value
  );
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function publicFlow(row: FlowRow): ChatGptDeviceFlowStatus {
  const state = row.state === "collecting" ? "pending" : row.state;
  return {
    flowId: row.id,
    state,
    expiresAt: dateValue(row.expiresAt),
    retryable: state !== "pending" && state !== "completed",
  };
}

function privateToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_CHARACTERS &&
    value.trim() === value
  );
}

/** Validate the narrow stable portion of Codex's evolving auth.json contract. */
export function isValidChatGptAuthDocument(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > MAX_AUTH_DOCUMENT_BYTES ||
    Buffer.byteLength(value, "utf8") > MAX_AUTH_DOCUMENT_BYTES
  ) {
    return false;
  }
  let document: Record<string, unknown> | undefined;
  try {
    document = objectValue(JSON.parse(value));
  } catch {
    return false;
  }
  const tokens = objectValue(document?.tokens);
  return (
    document?.auth_mode === "chatgpt" &&
    Boolean(tokens) &&
    privateToken(tokens?.access_token) &&
    privateToken(tokens?.refresh_token)
  );
}

async function lockActor(transaction: Transaction, actorUserId: string) {
  await lockPersonalAiActor(transaction, actorUserId);
}

/** Durable actor ownership and completion coordinator for browser-facing device flows. */
export function createChatGptDeviceFlowService(input: {
  database: Database;
  connections: ConnectionStore;
  agent: ChatGptDeviceAuthAgent;
  now?: () => Date;
}): ChatGptDeviceFlowService {
  const now = input.now ?? (() => new Date());

  function identities(actorUserId: unknown, flowId?: unknown) {
    if (!boundedActor(actorUserId))
      throw new ChatGptDeviceFlowUnavailableError();
    if (flowId === undefined) return { actorUserId };
    const canonical = canonicalFlowId(flowId);
    if (!canonical) throw new ChatGptDeviceFlowUnavailableError();
    return { actorUserId, flowId: canonical };
  }

  async function owned(actorUserId: string, flowId: string) {
    const [flow] = await input.database
      .select()
      .from(personalAiDeviceFlows)
      .where(
        and(
          eq(personalAiDeviceFlows.id, flowId),
          eq(personalAiDeviceFlows.userId, actorUserId),
        ),
      );
    if (!flow) throw new ChatGptDeviceFlowUnavailableError();
    return flow;
  }

  async function terminal(
    flow: FlowRow,
    state: Exclude<ChatGptDeviceFlowState, "pending" | "completed">,
  ) {
    const updated = await input.database.transaction(async (transaction) => {
      await lockActor(transaction, flow.userId);
      const [row] = await transaction
        .update(personalAiDeviceFlows)
        .set({ state, updatedAt: now() })
        .where(
          and(
            eq(personalAiDeviceFlows.id, flow.id),
            eq(personalAiDeviceFlows.userId, flow.userId),
            inArray(personalAiDeviceFlows.state, ["pending", "collecting"]),
          ),
        )
        .returning();
      return row;
    });
    const current = updated ?? (await owned(flow.userId, flow.id));
    return current.state === "completed"
      ? verifiedCompletion(current)
      : publicFlow(current);
  }

  async function verifiedCompletion(flow: FlowRow) {
    const [live] = await input.database
      .select({ id: credentials.id })
      .from(userAiConnections)
      .innerJoin(
        credentials,
        and(
          eq(credentials.id, userAiConnections.credentialId),
          eq(credentials.id, flow.credentialId as string),
          eq(credentials.kind, "model"),
          eq(credentials.provider, "chatgpt"),
          isNull(credentials.revokedAt),
        ),
      )
      .where(
        and(
          eq(userAiConnections.userId, flow.userId),
          eq(userAiConnections.provider, "chatgpt"),
          eq(userAiConnections.state, "active"),
          isNull(userAiConnections.disconnectedAt),
        ),
      );
    if (live) return publicFlow(flow);
    const [failed] = await input.database
      .update(personalAiDeviceFlows)
      .set({
        state: "failed",
        credentialId: null,
        completedAt: null,
        updatedAt: now(),
      })
      .where(
        and(
          eq(personalAiDeviceFlows.id, flow.id),
          eq(personalAiDeviceFlows.userId, flow.userId),
          eq(personalAiDeviceFlows.state, "completed"),
        ),
      )
      .returning();
    return publicFlow(failed ?? (await owned(flow.userId, flow.id)));
  }

  async function failStartedFlow(actorUserId: string, flowId: string) {
    await input.database
      .transaction(async (transaction) => {
        await lockActor(transaction, actorUserId);
        await transaction
          .update(personalAiDeviceFlows)
          .set({ state: "failed", updatedAt: now() })
          .where(
            and(
              eq(personalAiDeviceFlows.id, flowId),
              eq(personalAiDeviceFlows.userId, actorUserId),
              eq(personalAiDeviceFlows.state, "pending"),
            ),
          );
      })
      .catch(() => undefined);
  }

  async function failCollection(flow: FlowRow) {
    await input.agent.cancel(flow.id).catch(() => undefined);
    return terminal(flow, "failed");
  }

  async function complete(flow: FlowRow) {
    const claimed = await input.database.transaction(async (transaction) => {
      await lockActor(transaction, flow.userId);
      const [collecting] = await transaction
        .update(personalAiDeviceFlows)
        .set({ state: "collecting", updatedAt: now() })
        .where(
          and(
            eq(personalAiDeviceFlows.id, flow.id),
            eq(personalAiDeviceFlows.userId, flow.userId),
            eq(personalAiDeviceFlows.state, "pending"),
          ),
        )
        .returning();
      if (collecting) return collecting;
      const [current] = await transaction
        .select()
        .from(personalAiDeviceFlows)
        .where(
          and(
            eq(personalAiDeviceFlows.id, flow.id),
            eq(personalAiDeviceFlows.userId, flow.userId),
          ),
        );
      if (!current) throw new ChatGptDeviceFlowUnavailableError();
      return current;
    });
    if (claimed.state !== "collecting") {
      return claimed.state === "completed"
        ? verifiedCompletion(claimed)
        : publicFlow(claimed);
    }

    let collected: Awaited<ReturnType<ChatGptDeviceAuthAgent["collect"]>>;
    try {
      collected = await input.agent.collect(flow.id);
    } catch {
      return failCollection(claimed);
    }
    if (!isValidChatGptAuthDocument(collected.authDocument)) {
      return failCollection(claimed);
    }

    let prepared: Awaited<ReturnType<ConnectionStore["prepareConnection"]>>;
    try {
      prepared = await input.connections.prepareConnection({
        actorUserId: flow.userId,
        provider: "chatgpt",
        plaintext: collected.authDocument,
        safeMetadata: {},
      });
    } catch {
      return failCollection(claimed);
    }

    let result: FlowRow;
    try {
      result = await input.database.transaction(async (transaction) => {
        await lockActor(transaction, flow.userId);
        const [current] = await transaction
          .select()
          .from(personalAiDeviceFlows)
          .where(
            and(
              eq(personalAiDeviceFlows.id, flow.id),
              eq(personalAiDeviceFlows.userId, flow.userId),
            ),
          )
          .for("update");
        if (!current) throw new ChatGptDeviceFlowUnavailableError();
        if (current.state !== "collecting") return current;
        if (dateValue(current.expiresAt) <= now()) {
          const [expired] = await transaction
            .update(personalAiDeviceFlows)
            .set({ state: "expired", updatedAt: now() })
            .where(
              and(
                eq(personalAiDeviceFlows.id, flow.id),
                eq(personalAiDeviceFlows.userId, flow.userId),
                eq(personalAiDeviceFlows.state, "collecting"),
              ),
            )
            .returning();
          if (!expired) throw new Error("Device flow expiry was lost");
          return expired;
        }

        const stored = await input.connections.connectPrepared(
          transaction,
          prepared,
        );
        const timestamp = now();
        const [completed] = await transaction
          .update(personalAiDeviceFlows)
          .set({
            state: "completed",
            credentialId: stored.credentialId,
            completedAt: timestamp,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(personalAiDeviceFlows.id, flow.id),
              eq(personalAiDeviceFlows.userId, flow.userId),
              eq(personalAiDeviceFlows.state, "collecting"),
            ),
          )
          .returning();
        if (!completed) throw new Error("Device flow completion was lost");
        return completed;
      });
    } catch {
      return failCollection(claimed);
    }
    if (result.state === "expired") {
      await input.agent.cancel(flow.id).catch(() => undefined);
    }
    return result.state === "completed"
      ? verifiedCompletion(result)
      : publicFlow(result);
  }

  return Object.freeze({
    async start(actorUserId) {
      const identity = identities(actorUserId);
      const flowId = randomUUID();
      const placeholderExpiry = new Date(now().getTime() + DEFAULT_FLOW_TTL_MS);
      const previous = await input.database.transaction(async (transaction) => {
        await lockActor(transaction, identity.actorUserId);
        const [active] = await transaction
          .select({ id: personalAiDeviceFlows.id })
          .from(personalAiDeviceFlows)
          .where(
            and(
              eq(personalAiDeviceFlows.userId, identity.actorUserId),
              inArray(personalAiDeviceFlows.state, ["pending", "collecting"]),
            ),
          )
          .for("update");
        if (active) {
          await transaction
            .update(personalAiDeviceFlows)
            .set({ state: "cancelled", updatedAt: now() })
            .where(eq(personalAiDeviceFlows.id, active.id));
        }
        await transaction.insert(personalAiDeviceFlows).values({
          id: flowId,
          userId: identity.actorUserId,
          provider: "chatgpt",
          state: "pending",
          expiresAt: placeholderExpiry,
          updatedAt: now(),
        });
        return active?.id;
      });
      if (previous) await input.agent.cancel(previous).catch(() => undefined);

      let started: ChatGptDeviceFlowStart;
      try {
        started = await input.agent.start(flowId);
      } catch {
        await input.agent.cancel(flowId).catch(() => undefined);
        await failStartedFlow(identity.actorUserId, flowId);
        throw new ChatGptDeviceFlowServiceUnavailableError();
      }
      let updated: FlowRow | undefined;
      try {
        updated = await input.database.transaction(async (transaction) => {
          await lockActor(transaction, identity.actorUserId);
          const [row] = await transaction
            .update(personalAiDeviceFlows)
            .set({ expiresAt: started.expiresAt, updatedAt: now() })
            .where(
              and(
                eq(personalAiDeviceFlows.id, flowId),
                eq(personalAiDeviceFlows.userId, identity.actorUserId),
                eq(personalAiDeviceFlows.state, "pending"),
              ),
            )
            .returning();
          return row;
        });
      } catch {
        await input.agent.cancel(flowId).catch(() => undefined);
        await failStartedFlow(identity.actorUserId, flowId);
        throw new ChatGptDeviceFlowServiceUnavailableError();
      }
      if (!updated) {
        await input.agent.cancel(flowId).catch(() => undefined);
        await failStartedFlow(identity.actorUserId, flowId);
        throw new ChatGptDeviceFlowServiceUnavailableError();
      }
      return {
        ...publicFlow(updated),
        verificationUrl: started.verificationUrl,
        userCode: started.userCode,
      };
    },

    async status(actorUserId, flowId) {
      const identity = identities(actorUserId, flowId) as {
        actorUserId: string;
        flowId: string;
      };
      const flow = await owned(identity.actorUserId, identity.flowId);
      if (flow.state === "completed") return verifiedCompletion(flow);
      if (
        (flow.state === "pending" || flow.state === "collecting") &&
        dateValue(flow.expiresAt) <= now()
      ) {
        const status = await terminal(flow, "expired");
        if (status.state === "expired") {
          await input.agent.cancel(flow.id).catch(() => undefined);
        }
        return status;
      }
      if (flow.state === "collecting") {
        if (
          dateValue(flow.updatedAt).getTime() <=
          now().getTime() - COLLECTING_STALE_MS
        ) {
          const status = await terminal(flow, "failed");
          if (status.state === "failed") {
            await input.agent.cancel(flow.id).catch(() => undefined);
          }
          return status;
        }
        return publicFlow(flow);
      }
      if (flow.state !== "pending") return publicFlow(flow);

      let agentStatus: ChatGptDeviceFlowStatus;
      try {
        agentStatus = await input.agent.status(flow.id);
      } catch {
        return terminal(flow, "failed");
      }
      if (agentStatus.state === "completed") return complete(flow);
      if (agentStatus.state === "pending") {
        const updated = await input.database.transaction(
          async (transaction) => {
            await lockActor(transaction, flow.userId);
            const [row] = await transaction
              .update(personalAiDeviceFlows)
              .set({ expiresAt: agentStatus.expiresAt, updatedAt: now() })
              .where(
                and(
                  eq(personalAiDeviceFlows.id, flow.id),
                  eq(personalAiDeviceFlows.userId, flow.userId),
                  eq(personalAiDeviceFlows.state, "pending"),
                ),
              )
              .returning();
            return row;
          },
        );
        const current = updated ?? (await owned(flow.userId, flow.id));
        return current.state === "completed"
          ? verifiedCompletion(current)
          : publicFlow(current);
      }
      return terminal(flow, agentStatus.state);
    },

    async cancel(actorUserId, flowId) {
      const identity = identities(actorUserId, flowId) as {
        actorUserId: string;
        flowId: string;
      };
      const flow = await owned(identity.actorUserId, identity.flowId);
      if (flow.state === "completed") return verifiedCompletion(flow);
      if (flow.state !== "pending" && flow.state !== "collecting") {
        return publicFlow(flow);
      }
      const cancelled = await terminal(flow, "cancelled");
      if (cancelled.state === "cancelled") {
        await input.agent.cancel(flow.id).catch(() => undefined);
      }
      return cancelled;
    },

    async cancelInvalidated(flowIds) {
      await Promise.all(
        flowIds.map(async (flowId) => {
          const canonical = canonicalFlowId(flowId);
          if (!canonical) return;
          await input.agent.cancel(canonical).catch(() => undefined);
        }),
      );
    },
  });
}
