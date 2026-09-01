import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { clearPersonalAiClientState } from "@/lib/ai-connections/mutations";
import { client } from "@/lib/client";
import { authKeys } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    fallback: "Could not sign out",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onMutate: () => clearPersonalAiClientState(queryClient),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: authKeys.all });
      // An active settings query can briefly refetch between the optimistic purge and the
      // successful sign-out. Purge once more after removing the actor identity so that this
      // response cannot survive into the next signed-in user's session.
      await clearPersonalAiClientState(queryClient);
    },
  });
}
