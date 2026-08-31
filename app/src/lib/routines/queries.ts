import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One standing instruction, as the Routines page sees it.
 *
 * `schedule` IS OPAQUE DISPLAY TEXT, NEVER A VALUE TO PARSE. The server computes it once, from the
 * same library that decides when the routine actually fires — prose for a shape it recognizes, the
 * raw five-field cron expression for anything stranger than that. Rendering it verbatim is the only
 * correct thing to do with it; a second cron-to-English implementation in the browser would drift
 * out of step with the server's the first time either one changes.
 */
export type RoutineRecord = {
  id: string;
  agentId: string;
  schedule: string;
  cron: string;
  timezone: string;
  instruction: string;
  channel: { id: string; name: string | null; gone: boolean };
  enabled: boolean;
  nextRunAt: string;
  /**
   * Null means no run has ever finished. An object with `status: null` means a run is open —
   * started but not yet finished, whether genuinely in flight or stuck there after repeated
   * dispatch failures. Neither is a failure; only `status: "failed"` is.
   */
  lastRun: {
    status: "succeeded" | "failed" | "skipped" | null;
    at: string | null;
  } | null;
  overlapPolicy: "skip";
};

export type RoutineRunRecord = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "succeeded" | "failed" | "skipped" | null;
  durationMs: number | null;
  error: string | null;
};

export type RoutineWorkerHealth = {
  status: "operational" | "stale" | "unavailable";
  lastHeartbeatAt: string | null;
};

export const routineKeys = {
  all: ["routines"] as const,
  list: () => ["routines", "list"] as const,
  runs: (id: string) => ["routines", id, "runs"] as const,
  health: () => ["routines", "worker-health"] as const,
};

/**
 * The signed-in person's own routines.
 *
 * Owner-scoped by the server on every read; there is no version of this that takes an owner id,
 * the same way `connectionsQueryOptions` answers only for whoever is asking.
 */
export function routinesQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.list(),
    queryFn: (): Promise<RoutineRecord[]> =>
      client("/api/routines", "routines", {
        fallback: "Your routines could not be loaded.",
      }),
  });
}

export function routineRunsQueryOptions(id: string | null) {
  return queryOptions({
    queryKey: routineKeys.runs(id ?? "closed"),
    enabled: id !== null,
    queryFn: (): Promise<RoutineRunRecord[]> =>
      client(`/api/routines/${encodeURIComponent(id ?? "")}/runs`, "runs", {
        fallback: "Routine history could not be loaded.",
      }),
    refetchInterval: 10_000,
  });
}

/** Global scheduler health, refreshed independently from a person's routine list. */
export function routineWorkerHealthQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.health(),
    queryFn: (): Promise<RoutineWorkerHealth> =>
      client("/api/routines/health", "worker", {
        fallback: "Routine worker health could not be loaded.",
      }),
    refetchInterval: 30_000,
  });
}
