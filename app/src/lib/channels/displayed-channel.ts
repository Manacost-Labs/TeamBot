import type { AgentChannel } from "./queries";

/**
 * Keep the last resolved channel on screen while the next channel is being fetched.
 *
 * A route parameter changes before its detail query has data. Replacing the transcript with a
 * loading panel in that gap makes every click look like a hard cut (and a slow response looks like
 * a blank screen). The caller keeps the returned value in state and swaps it only when the query
 * confirms that the response belongs to the requested channel.
 */
export function nextDisplayedChannel(
  current: AgentChannel | undefined,
  candidate: AgentChannel | undefined,
  requestedId: string,
): AgentChannel | undefined {
  return candidate?.id === requestedId ? candidate : current;
}
