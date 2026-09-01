import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import {
  aiConnectionKeys,
  type PersonalAiConnection,
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

function failureFor(status: number): AiConnectionMutationFailure {
  if (status === 400 || status === 422) return "invalid-key";
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "not-authorized";
  return "unavailable";
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
  connection: PersonalAiConnection | null,
) {
  queryClient.setQueryData(aiConnectionKeys.status(), connection);
}

/**
 * The mutation receives no variables. In particular, the API key never becomes TanStack mutation
 * state: the component hands over a one-shot reader that empties the DOM input before this request
 * begins.
 */
export function connectOpenRouterMutationOptions(
  queryClient: QueryClient,
  takeApiKey: () => string,
) {
  return mutationOptions<
    PersonalAiConnection | null,
    AiConnectionMutationError,
    void
  >({
    mutationKey: [...aiConnectionKeys.all, "connect-openrouter"],
    mutationFn: async () => {
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
    onSuccess: (connection) => writeStatus(queryClient, connection),
  });
}

export function disconnectPersonalAiMutationOptions(queryClient: QueryClient) {
  return mutationOptions<
    PersonalAiConnection | null,
    AiConnectionMutationError,
    void
  >({
    mutationKey: [...aiConnectionKeys.all, "disconnect"],
    mutationFn: async () => {
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
    onSuccess: (connection) => writeStatus(queryClient, connection),
  });
}
