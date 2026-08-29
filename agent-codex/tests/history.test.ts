import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { deploymentToolNames, instructionsFor, transcriptFor } from "../src/history";

const input = {
  threadId: "thread",
  runId: "run",
  messages: [
    { id: "s", role: "system", content: "Tenant rule." },
    { id: "u", role: "user", content: "Hello" },
    { id: "a", role: "assistant", content: "Hi" },
  ],
  tools: [],
  context: [],
  state: {},
  forwardedProps: { openbotDeploymentTools: ["allowed", 42] },
} as unknown as RunAgentInput;

describe("Codex prompt translation", () => {
  test("keeps higher-priority instructions out of the quoted transcript", () => {
    expect(instructionsFor(input)).toContain("Tenant rule.");
    expect(transcriptFor(input)).not.toContain("Tenant rule.");
    expect(transcriptFor(input)).toContain("[user] Hello");
  });

  test("accepts only deployment-declared tool names", () => {
    expect([...deploymentToolNames(input)]).toEqual(["allowed"]);
  });
});
