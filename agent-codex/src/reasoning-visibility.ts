import type { RunAgentInput } from "@ag-ui/core";
import { isResearchRun, isYoutubeAnalystRun } from "./history";

/** Only ordinary runs may stream model reasoning summaries to the UI. */
export function shouldExposeReasoning(input: RunAgentInput): boolean {
  return !isResearchRun(input) && !isYoutubeAnalystRun(input);
}
