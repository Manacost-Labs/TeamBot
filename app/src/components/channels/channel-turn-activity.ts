import { type AgentRunState, isAgentRunActive } from "@/lib/copilot/run-state";

/** Visual activity only; delivery and queue safety keep their own transport guards. */
export function isChannelTurnBusy({
  isRunning,
  joined,
  joinExecutionActive = false,
  turnsInFlight,
  run,
}: {
  isRunning: boolean;
  joined: boolean;
  /** Independent server execution evidence for a run started outside this tab. */
  joinExecutionActive?: boolean;
  turnsInFlight: number;
  run: AgentRunState;
}): boolean {
  return (
    // connectAgent sets isRunning while replaying even an idle thread. Only use that fallback
    // after the initial join or when the server independently confirms a live run. Local sends
    // and tracked background runs remain visible throughout the join without waiting for a read.
    ((joined || joinExecutionActive) && isRunning) ||
    turnsInFlight > 0 ||
    (run.startedAt !== null && isAgentRunActive(run.status))
  );
}
