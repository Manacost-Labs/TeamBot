import { afterEach, describe, expect, test } from "bun:test";
import { callTool, listTools } from "../src/plugins/builtin-heartpulse-ops";

const previousToken = process.env.AGENT_TOOL_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_TOOL_TOKEN;
  else process.env.AGENT_TOOL_TOKEN = previousToken;
});

describe("HeartPulse Ops transport", () => {
  test("advertises the governed audit, repair and verification cycle", async () => {
    expect((await listTools()).map((tool) => tool.name)).toEqual([
      "audit_site_sections",
      "audit_strategy_data",
      "diagnose_rendering",
      "codegraph_explore",
      "workspace_status",
      "validate_workspace",
      "publish_and_verify",
    ]);
  });

  test("fails closed before making a call when its boundary secret is absent", async () => {
    delete process.env.AGENT_TOOL_TOKEN;
    const response = await callTool({}, "audit_strategy_data", {});
    expect(response.isError).toBe(true);
    expect(response.text).toContain("not configured");
  });

  test("refuses a tool it never advertised", async () => {
    process.env.AGENT_TOOL_TOKEN = "test-boundary-secret";
    const response = await callTool({}, "run_any_shell", {});
    expect(response.isError).toBe(true);
    expect(response.text).toContain("does not offer");
  });
});
