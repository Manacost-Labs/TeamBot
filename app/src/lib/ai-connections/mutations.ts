import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import {
  aiConnectionKeys,
  type ChatGptDeviceFlow,
  ChatGptDeviceFlowQueryError,
  type PersonalAiConnection,
  projectChatGptDeviceFlowEnvelope,
  projectPersonalAiConnection,
} from "./queries";

export type AiConnectionMutationFailure =
  | "invalid-key"
  | "rate-limited"
  | "unavailable"
  | "not-authorized"
  | "invalid-response";

export class AiConnectionMutationError extends Error {
  readonly reason: AiConnectionMutationFailure;

  constructor(reason: AiConnectionMutationFailure) {
    super("Personal AI connection could not be changed");
    this.name = "AiConnectionMutationError";
    this.reason = reason;
  }
}

export type ChatGptDeviceFlowMutationFailure =
  | "not-authorized"
  | "unavailable"
  | "invalid-response";

export class ChatGptDeviceFlowMutationError extends Error {
  readonly reason: ChatGptDeviceFlowMutationFailure;

  constructor(reason: ChatGptDeviceFlowMutationFailure) {
    super("ChatGPT connection flow could not be changed");
    this.name = "ChatGptDeviceFlowMutationError";
    this.reason = reason;
  }
}

const CHATGPT_DEVICE_FLOW_PATH = "/api/ai-connections/chatgpt/device-flow";

function failureFor(status: number): AiConnectionMutationFailure {
  if (status === 400 || status === 422) return "invalid-key";
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "not-authorized";
  return "unavailable";
}

function chatGptFailureFor(status: number): ChatGptDeviceFlowMutationFailure {
  return status === 401 || status === 403 ? "not-authorized" : "unavailable";
}

async function projectedDeviceFlow(
  response: Response,
  expectedFlowId?: string,
): Promise<ChatGptDeviceFlow> {
  let flowId = expectedFlowId;
  if (!flowId) {
    const clone = response.clone();
    let body: unknown;
    try {
      body = await clone.json();
    } catch {
      throw new ChatGptDeviceFlowMutationError("invalid-response");
    }
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    const flow =
      envelope?.flow &&
      typeof envelope.flow === "object" &&
      !Array.isArray(envelope.flow)
        ? (envelope.flow as Record<string, unknown>)
        : undefined;
    flowId = typeof flow?.flowId === "string" ? flow.flowId : undefined;
  }
  if (!flowId) {
    throw new ChatGptDeviceFlowMutationError("invalid-response");
  }
  try {
    return await projectChatGptDeviceFlowEnvelope(
      response,
      flowId,
      expectedFlowId === undefined,
    );
  } catch (error) {
    if (error instanceof ChatGptDeviceFlowQueryError) {
      throw new ChatGptDeviceFlowMutationError(error.reason);
    }
    throw new ChatGptDeviceFlowMutationError("invalid-response");
  }
}

async function projectedConnection(
  response: Response,
): Promise<PersonalAiConnection | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AiConnectionMutationError("invalid-response");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AiConnectionMutationError("invalid-response");
  }
  try {
    return projectPersonalAiConnection(
      (body as Record<string, unknown>).connection,
    );
  } catch {
    throw new AiConnectionMutationError("invalid-response");
  }
}

function writeStatus(
  queryClient: QueryClient,
  actorId: string,
  connection: PersonalAiConnection | null,
) {
  queryClient.setQueryData(aiConnectionKeys.status(actorId), connection);
}

export async function clearPersonalAiClientState(
  queryClient: QueryClient,
  actorId?: string,
) {
  const queryKey = actorId
    ? aiConnectionKeys.actor(actorId)
    : aiConnectionKeys.all;
  await queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
  const mutationCache = queryClient.getMutationCache();
  for (const mutation of mutationCache.findAll({ mutationKey: queryKey })) {
    mutationCache.remove(mutation);
  }
}

/**
 * The mutation receives no variables. In particular, the API key never becomes TanStack mutation
 * state: the component hands over a one-shot reader that empties the DOM input before this request
 * begins.
 */
export function connectOpenRouterMutationOptions(
  queryClient: QueryClient,
  actorId: string,
  takeApiKey: () => string,
  isActorCurrent: () => boolean = () => true,
) {
  return mutationOptions<
    PersonalAiConnection | null,
    AiConnectionMutationError,
    void
  >({
    mutationKey: [...aiConnectionKeys.actor(actorId), "connect-openrouter"],
    mutationFn: async () => {
      if (!actorId) throw new AiConnectionMutationError("not-authorized");
      const apiKey = takeApiKey();
      if (!apiKey) throw new AiConnectionMutationError("invalid-key");
      const response = await tryClient("/api/ai-connections", {
        method: "PUT",
        body: { provider: "openrouter", apiKey },
      }).catch(() => {
        throw new AiConnectionMutationError("unavailable");
      });
      if (!response.ok) {
        // Do not parse a rejected provider response: even a bad server message must not enter the
        // mutation error object or the rendered DOM.
        throw new AiConnectionMutationError(failureFor(response.status));
      }
      return projectedConnection(response);
    },
    onSuccess: (connection) => {
      if (isActorCurrent()) writeStatus(queryClient, actorId, connection);
    },
  });
}

export function disconnectPersonalAiMutationOptions(
  queryClient: QueryClient,
  actorId: string,
  isActorCurrent: () => boolean = () => true,
) {
  return mutationOptions<
    PersonalAiConnection | null,
    AiConnectionMutationError,
    void
  >({
    mutationKey: [...aiConnectionKeys.actor(actorId), "disconnect"],
    mutationFn: async () => {
      if (!actorId) throw new AiConnectionMutationError("not-authorized");
      const response = await tryClient("/api/ai-connections", {
        method: "DELETE",
      }).catch(() => {
        throw new AiConnectionMutationError("unavailable");
      });
      if (!response.ok) {
        throw new AiConnectionMutationError(failureFor(response.status));
      }
      return projectedConnection(response);
    },
    onSuccess: (connection) => {
      if (isActorCurrent()) writeStatus(queryClient, actorId, connection);
    },
  });
}

export function startChatGptDeviceFlowMutationOptions(
  queryClient: QueryClient,
  actorId: string,
  isActorCurrent: () => boolean = () => true,
) {
  return mutationOptions<
    ChatGptDeviceFlow,
    ChatGptDeviceFlowMutationError,
    void
  >({
    mutationKey: [
      ...aiConnectionKeys.actor(actorId),
      "start-chatgpt-device-flow",
    ],
    mutationFn: async () => {
      if (!actorId) {
        throw new ChatGptDeviceFlowMutationError("not-authorized");
      }
      const response = await tryClient(CHATGPT_DEVICE_FLOW_PATH, {
        method: "POST",
        body: {},
      }).catch(() => {
        throw new ChatGptDeviceFlowMutationError("unavailable");
      });
      if (!response.ok) {
        throw new ChatGptDeviceFlowMutationError(
          chatGptFailureFor(response.status),
        );
      }
      return projectedDeviceFlow(response);
    },
    onSuccess: (flow) => {
      if (!isActorCurrent()) return;
      queryClient.setQueryData(
        aiConnectionKeys.deviceFlow(actorId, flow.flowId),
        flow,
      );
    },
  });
}

export function cancelChatGptDeviceFlowMutationOptions(
  queryClient: QueryClient,
  actorId: string,
  isActorCurrent: () => boolean = () => true,
) {
  return mutationOptions<
    ChatGptDeviceFlow,
    ChatGptDeviceFlowMutationError,
    string
  >({
    mutationKey: [
      ...aiConnectionKeys.actor(actorId),
      "cancel-chatgpt-device-flow",
    ],
    onMutate: async (flowId) => {
      await queryClient.cancelQueries({
        queryKey: aiConnectionKeys.deviceFlow(actorId, flowId),
      });
    },
    mutationFn: async (flowId) => {
      if (!actorId) {
        throw new ChatGptDeviceFlowMutationError("not-authorized");
      }
      const response = await tryClient(
        `${CHATGPT_DEVICE_FLOW_PATH}/${encodeURIComponent(flowId)}`,
        { method: "DELETE" },
      ).catch(() => {
        throw new ChatGptDeviceFlowMutationError("unavailable");
      });
      if (!response.ok) {
        throw new ChatGptDeviceFlowMutationError(
          chatGptFailureFor(response.status),
        );
      }
      return projectedDeviceFlow(response, flowId);
    },
    onSuccess: async (flow) => {
      const queryKey = aiConnectionKeys.deviceFlow(actorId, flow.flowId);
      // The request cancelled in onMutate may already have scheduled a replacement fetch. Fence
      // that request too before publishing the terminal state, so a late `pending` response cannot
      // overwrite `cancelled` and restart polling.
      await queryClient.cancelQueries({ queryKey });
      if (!isActorCurrent()) {
        queryClient.removeQueries({ queryKey });
        return;
      }
      queryClient.setQueryData(queryKey, flow);
    },
  });
}
