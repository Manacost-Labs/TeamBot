import { describe, expect, it } from "bun:test";
import {
  codexToolName,
  modelFor,
  toolCallNames,
  workspaceFor,
} from "../src/codex-run";

describe("Codex dynamic tool names", () => {
  it("moves governed MCP tools out of Codex's reserved namespace", () => {
    expect(codexToolName("mcp__parser-ops__audit_all_sources")).toBe(
      "openbot__parser-ops__audit_all_sources",
    );
  });

  it("does not rename ordinary deployment tools", () => {
    expect(codexToolName("workspace_status")).toBe("workspace_status");
  });

  it("reports the safe wire name while calling the governed deployment name", () => {
    const names = toolCallNames(
      "openbot__parser-ops__audit_all_sources",
      new Map([
        [
          "openbot__parser-ops__audit_all_sources",
          "mcp__parser-ops__audit_all_sources",
        ],
      ]),
    );

    expect(names).toEqual({
      deploymentName: "mcp__parser-ops__audit_all_sources",
      eventName: "openbot__parser-ops__audit_all_sources",
    });
  });

  it("uses the managed coworker's model and workspace override", () => {
    const input = {
      agentId: "heartpulse-control",
      forwardedProps: { openbotAgentModel: "gpt-5.6-luna-xhigh" },
    } as never;
    expect(modelFor(input)).toBe("gpt-5.6-luna-xhigh");
    expect(workspaceFor(input)).toBe("/workspace-heartpulse");
  });

  it("ignores unsafe model overrides", () => {
    const input = {
      forwardedProps: { openbotAgentModel: "gpt-5.6-luna-xhigh;rm" },
    } as never;
    expect(modelFor(input)).not.toBe("gpt-5.6-luna-xhigh;rm");
  });
});
