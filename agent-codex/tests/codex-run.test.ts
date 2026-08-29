import { describe, expect, it } from "bun:test";
import { codexToolName } from "../src/codex-run";

describe("Codex dynamic tool names", () => {
  it("moves governed MCP tools out of Codex's reserved namespace", () => {
    expect(codexToolName("mcp__parser-ops__audit_all_sources")).toBe(
      "openbot__parser-ops__audit_all_sources",
    );
  });

  it("does not rename ordinary deployment tools", () => {
    expect(codexToolName("workspace_status")).toBe("workspace_status");
  });
});
