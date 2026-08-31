import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { routineKeys } from "./queries";

/**
 * Writes against a person's own standing instructions.
 *
 * Creation remains conversational through `RoutineTools`; direct controls here edit an existing
 * routine, pause/resume it, run it now and remove it.
 */

const FALLBACK = "That routine could not be changed.";

function invalidateRoutines(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: routineKeys.all });
}

/** Switch one routine on or off. Immediate; there is no save. */
export function setRoutineEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; enabled: boolean }) =>
      client(`/api/routines/${encodeURIComponent(variables.id)}/enabled`, {
        method: "PUT",
        body: { enabled: variables.enabled },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

export function deleteRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

export type RoutineUpdate = {
  id: string;
  agentId: string;
  channelId: string;
  instruction: string;
  cron: string;
  timezone: string;
  overlapPolicy: "skip" | "queue_one" | "allow_overlap";
};

export function updateRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({ id, ...body }: RoutineUpdate) =>
      client(`/api/routines/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

export function runRoutineNowMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}/run`, {
        method: "POST",
        fallback: "That routine could not be started.",
      }),
    onSuccess: (_data, id) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: routineKeys.list() }),
        queryClient.invalidateQueries({ queryKey: routineKeys.runs(id) }),
      ]),
  });
}
