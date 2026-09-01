import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

export type PersonalAiSafeMetadata = {
  usageUsd?: number;
  limitUsd?: number | null;
  limitRemainingUsd?: number | null;
  isFreeTier?: boolean;
};

export type PersonalAiConnection = {
  provider: "chatgpt" | "openrouter";
  state: "active" | "disconnected";
  validatedAt: string;
  disconnectedAt: string | null;
  updatedAt: string;
  safeMetadata: PersonalAiSafeMetadata;
};

export type ChatGptDeviceFlowState =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ChatGptDeviceFlow = {
  flowId: string;
  state: ChatGptDeviceFlowState;
  expiresAt: string;
  retryable: boolean;
  verificationUrl?: "https://auth.openai.com/codex/device";
  userCode?: string;
};

export type ChatGptDeviceFlowQueryFailure =
  | "not-authorized"
  | "unavailable"
  | "invalid-response";

export class ChatGptDeviceFlowQueryError extends Error {
  readonly reason: ChatGptDeviceFlowQueryFailure;

  constructor(reason: ChatGptDeviceFlowQueryFailure) {
    super("ChatGPT connection status could not be checked");
    this.name = "ChatGptDeviceFlowQueryError";
    this.reason = reason;
  }
}

const CHATGPT_DEVICE_FLOW_PATH = "/api/ai-connections/chatgpt/device-flow";
const CHATGPT_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const FLOW_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER_CODE = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/;
const FLOW_STATES = new Set<ChatGptDeviceFlowState>([
  "pending",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const aiConnectionKeys = {
  all: ["personal-ai-connection"] as const,
  actor: (actorId: string) => [...aiConnectionKeys.all, actorId] as const,
  status: (actorId: string) =>
    [...aiConnectionKeys.actor(actorId), "status"] as const,
  deviceFlow: (actorId: string, flowId: string) =>
    [
      ...aiConnectionKeys.actor(actorId),
      "chatgpt-device-flow",
      flowId,
    ] as const,
};

const signedOutAiConnectionKeys = {
  status: ["signed-out-personal-ai-connection", "status"] as const,
  deviceFlow: [
    "signed-out-personal-ai-connection",
    "chatgpt-device-flow",
  ] as const,
};

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nullableFiniteNonNegative(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finiteNonNegative(value);
}

function safeMetadata(value: unknown): PersonalAiSafeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const projected: PersonalAiSafeMetadata = {};
  const usageUsd = finiteNonNegative(source.usageUsd);
  const limitUsd = nullableFiniteNonNegative(source.limitUsd);
  const limitRemainingUsd = nullableFiniteNonNegative(source.limitRemainingUsd);
  if (usageUsd !== undefined) projected.usageUsd = usageUsd;
  if (limitUsd !== undefined) projected.limitUsd = limitUsd;
  if (limitRemainingUsd !== undefined) {
    projected.limitRemainingUsd = limitRemainingUsd;
  }
  if (typeof source.isFreeTier === "boolean") {
    projected.isFreeTier = source.isFreeTier;
  }
  return projected;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return parsed.toISOString() === value ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function flowFailure(status: number): ChatGptDeviceFlowQueryFailure {
  return status === 401 || status === 403 ? "not-authorized" : "unavailable";
}

/**
 * Project the device-flow response before it reaches component or query state. Unknown response
 * fields are deliberately discarded, so a future server regression cannot make auth material part
 * of browser state or rendered diagnostics.
 */
export function projectChatGptDeviceFlow(
  value: unknown,
  expectedFlowId: string,
  requireVerification = false,
): ChatGptDeviceFlow {
  const source = objectValue(value);
  const flowId = typeof source?.flowId === "string" ? source.flowId : "";
  const state = source?.state;
  const expiresAt = canonicalTimestamp(source?.expiresAt);
  const retryable = source?.retryable;
  const verificationUrl = source?.verificationUrl;
  const userCode = source?.userCode;
  if (
    !FLOW_ID.test(expectedFlowId) ||
    flowId !== expectedFlowId ||
    typeof state !== "string" ||
    !FLOW_STATES.has(state as ChatGptDeviceFlowState) ||
    !expiresAt ||
    typeof retryable !== "boolean" ||
    ((state === "pending" || state === "completed") && retryable) ||
    ((state === "failed" || state === "cancelled" || state === "expired") &&
      !retryable)
  ) {
    throw new ChatGptDeviceFlowQueryError("invalid-response");
  }
  if (
    requireVerification &&
    (state !== "pending" ||
      verificationUrl !== CHATGPT_VERIFICATION_URL ||
      typeof userCode !== "string" ||
      !USER_CODE.test(userCode))
  ) {
    throw new ChatGptDeviceFlowQueryError("invalid-response");
  }

  const projected: ChatGptDeviceFlow = {
    flowId,
    state: state as ChatGptDeviceFlowState,
    expiresAt,
    retryable,
  };
  if (requireVerification) {
    projected.verificationUrl = CHATGPT_VERIFICATION_URL;
    projected.userCode = userCode as string;
  }
  return projected;
}

export async function projectChatGptDeviceFlowEnvelope(
  response: Response,
  expectedFlowId: string,
  requireVerification = false,
): Promise<ChatGptDeviceFlow> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ChatGptDeviceFlowQueryError("invalid-response");
  }
  return projectChatGptDeviceFlow(
    objectValue(body)?.flow,
    expectedFlowId,
    requireVerification,
  );
}

export async function fetchChatGptDeviceFlow(
  flowId: string,
  signal?: AbortSignal,
): Promise<ChatGptDeviceFlow> {
  if (!FLOW_ID.test(flowId)) {
    throw new ChatGptDeviceFlowQueryError("invalid-response");
  }
  const response = await tryClient(
    `${CHATGPT_DEVICE_FLOW_PATH}/${encodeURIComponent(flowId)}`,
    { signal },
  ).catch(() => {
    throw new ChatGptDeviceFlowQueryError("unavailable");
  });
  if (!response.ok) {
    throw new ChatGptDeviceFlowQueryError(flowFailure(response.status));
  }
  return projectChatGptDeviceFlowEnvelope(response, flowId);
}

export function chatGptDeviceFlowQueryOptions(actorId: string, flowId: string) {
  return queryOptions({
    queryKey:
      actorId && flowId
        ? aiConnectionKeys.deviceFlow(actorId, flowId)
        : signedOutAiConnectionKeys.deviceFlow,
    queryFn: ({ signal }) => fetchChatGptDeviceFlow(flowId, signal),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * Treat the HTTP response as untrusted even though it came from our server. Only this projection is
 * allowed into React Query, so an accidental future server field cannot make a credential linger in
 * browser memory.
 */
export function projectPersonalAiConnection(
  value: unknown,
): PersonalAiConnection | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Personal AI connection returned an invalid status");
  }
  const source = value as Record<string, unknown>;
  const provider = source.provider;
  const state = source.state;
  const validatedAt = canonicalTimestamp(source.validatedAt);
  const updatedAt = canonicalTimestamp(source.updatedAt);
  const disconnectedAt =
    source.disconnectedAt === null
      ? null
      : canonicalTimestamp(source.disconnectedAt);
  if (
    (provider !== "chatgpt" && provider !== "openrouter") ||
    (state !== "active" && state !== "disconnected") ||
    !validatedAt ||
    !updatedAt ||
    disconnectedAt === undefined
  ) {
    throw new Error("Personal AI connection returned an invalid status");
  }
  return {
    provider,
    state,
    validatedAt,
    disconnectedAt,
    updatedAt,
    safeMetadata: safeMetadata(source.safeMetadata),
  };
}

export async function fetchPersonalAiConnection(): Promise<PersonalAiConnection | null> {
  const connection = await client<unknown>(
    "/api/ai-connections",
    "connection",
    { fallback: "Could not load personal AI connection" },
  );
  return projectPersonalAiConnection(connection);
}

export function personalAiConnectionQueryOptions(actorId: string) {
  return queryOptions({
    queryKey: actorId
      ? aiConnectionKeys.status(actorId)
      : signedOutAiConnectionKeys.status,
    queryFn: fetchPersonalAiConnection,
    enabled: Boolean(actorId),
    staleTime: 30_000,
  });
}
