import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

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

export const aiConnectionKeys = {
  all: ["personal-ai-connection"] as const,
  status: () => [...aiConnectionKeys.all, "status"] as const,
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

export function personalAiConnectionQueryOptions() {
  return queryOptions({
    queryKey: aiConnectionKeys.status(),
    queryFn: fetchPersonalAiConnection,
    staleTime: 30_000,
  });
}
