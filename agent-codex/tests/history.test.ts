import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import {
  deploymentToolNames,
  instructionsFor,
  permissionProfileFor,
  transcriptFor,
} from "../src/history";

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
  test("allows the data-control profile to commit inside its dedicated clone", async () => {
    const config = await Bun.file(
      new URL("../config.toml", import.meta.url),
    ).text();
    expect(config).toContain('"/workspace/.git" = "write"');
  });

  test("gives only the data-control agent a writable parser workspace", () => {
    expect(permissionProfileFor(input)).toBe("openbot-agent");
    const dataControl = { ...input, agentId: "data-control" } as RunAgentInput;
    expect(permissionProfileFor(dataControl)).toBe("data-control-agent");
    expect(instructionsFor(dataControl)).toContain("dedicated clone");
    expect(instructionsFor(dataControl)).toContain(
      "unexpected_selected_params",
    );
    expect(instructionsFor(dataControl)).toContain(
      "Follow diagnose_source.triage",
    );
    const detectedByTool = {
      ...input,
      tools: [
        {
          name: "mcp__parser-ops__diagnose_source",
          description: "Diagnose",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as unknown as RunAgentInput;
    expect(permissionProfileFor(detectedByTool)).toBe("data-control-agent");
  });

  test("keeps higher-priority instructions out of the quoted transcript", () => {
    expect(instructionsFor(input)).toContain("Tenant rule.");
    expect(transcriptFor(input)).not.toContain("Tenant rule.");
    expect(transcriptFor(input)).toContain("[user] Hello");
  });

  test("does not feed display-only reasoning summaries back into the next turn", () => {
    const withReasoning = {
      ...input,
      messages: [
        ...input.messages,
        { id: "r", role: "reasoning", content: "I checked the current state." },
        { id: "u2", role: "user", content: "Continue" },
      ],
    } as unknown as RunAgentInput;

    const transcript = transcriptFor(withReasoning);
    expect(transcript).not.toContain("I checked the current state.");
    expect(transcript).toContain("[user] Continue");
  });

  test("accepts only deployment-declared tool names", () => {
    expect([...deploymentToolNames(input)]).toEqual(["allowed"]);
  });

  test("keeps data-control history bounded to the last outcome and current firing", () => {
    const dataControl = {
      ...input,
      agentId: "data-control",
      messages: [
        { id: "u1", role: "user", content: "Old firing" },
        { id: "a1", role: "assistant", content: "Last outcome" },
        { id: "t1", role: "tool", content: "Large old audit" },
        { id: "u2", role: "user", content: "Current firing" },
      ],
    } as unknown as RunAgentInput;

    const transcript = transcriptFor(dataControl);
    expect(transcript).toContain("Last outcome");
    expect(transcript).toContain("Current firing");
    expect(transcript).not.toContain("Old firing");
    expect(transcript).not.toContain("Large old audit");
  });
});
