import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type PluginStore,
  refFromToolName,
  toolNameFor,
} from "../src/plugins/store";
import {
  type GrantedTool,
  grantedToolGuidance,
  grantedTools,
} from "../src/plugins/tools";

const SAFE_MODEL_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function guidanceTool(ref: string): GrantedTool {
  return {
    name: toolNameFor(ref),
    ref,
    description: "A test tool.",
    parameters: z.object({}),
    execute: async () => "called",
  };
}

describe("provider-safe plugin tool names", () => {
  test("preserves valid legacy names and round-trips them", () => {
    const ref = "google-drive/search_files";
    const toolName = toolNameFor(ref);

    expect(toolName).toBe("mcp__google-drive__search_files");
    expect(refFromToolName(toolName)).toBe(ref);
  });

  test("separates dotted names from their underscore sanitization neighbours", () => {
    const dotted = "oomol-connector/github.get_current_user";
    const underscored = "oomol-connector/github_get_current_user";

    expect(toolNameFor(dotted)).toMatch(SAFE_MODEL_TOOL_NAME);
    expect(toolNameFor(dotted)).not.toBe(toolNameFor(underscored));
  });

  test("keeps hashed aliases outside the legacy namespace", () => {
    const invalidRef = "oomol-connector/github.get_current_user";
    const alias = toolNameFor(invalidRef);
    const legacyRef = alias
      .replace(/^(?:mcp_h__|mcp__)/, "")
      .replace("__", "/");

    expect(alias).toMatch(/^mcp_h__/);
    expect(toolNameFor(legacyRef)).not.toBe(alias);
    expect(refFromToolName(toolNameFor(legacyRef))).toBe(legacyRef);
  });

  test("keeps long refs with the same prefix distinct", () => {
    const first = `oomol-connector/${`github.get_${"x".repeat(120)}`}one`;
    const second = `oomol-connector/${`github.get_${"x".repeat(120)}`}two`;

    expect(toolNameFor(first)).toMatch(SAFE_MODEL_TOOL_NAME);
    expect(toolNameFor(second)).toMatch(SAFE_MODEL_TOOL_NAME);
    expect(toolNameFor(first)).not.toBe(toolNameFor(second));
  });

  test("sanitizes invalid characters and respects the provider length limit", () => {
    const ref = `${"server.name"}/${`tool name:${"x".repeat(200)}`}`;
    const toolName = toolNameFor(ref);

    expect(toolName).toMatch(SAFE_MODEL_TOOL_NAME);
    expect(toolName).toHaveLength(64);
  });

  test("resolves hashed aliases only when the known refs identify them", () => {
    const ref = "oomol-connector/github.get_current_user";
    const alias = toolNameFor(ref);

    expect(refFromToolName(alias)).toBeNull();
    expect(refFromToolName(alias, [ref])).toBe(ref);
    expect(
      refFromToolName(alias, ["oomol-connector/github_get_current_user"]),
    ).toBeNull();
  });

  test("round-trips valid legacy names with hash-looking suffixes", () => {
    const ref = `legacy-server/tool__h${"a".repeat(16)}`;
    const toolName = toolNameFor(ref);

    expect(toolName).toBe(`mcp__legacy-server__tool__h${"a".repeat(16)}`);
    expect(refFromToolName(toolName)).toBe(ref);
  });
});

test("granted tool dispatch keeps the original raw ref behind its safe alias", async () => {
  const ref = "oomol-connector/github.get_current_user";
  const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
  const store = {
    listForAgent: async () => ({
      tools: [
        {
          ref,
          toolName: toolNameFor(ref),
          description: "Get the current GitHub user.",
          inputSchema: { type: "object" },
        },
      ],
      skills: [],
    }),
    callTool: async (input: { ref: string; args: Record<string, unknown> }) => {
      calls.push(input);
      return { text: "called", isError: false };
    },
  } as unknown as PluginStore;

  const [tool] = await grantedTools({
    store,
    botId: "bot-1",
    actorId: "actor-1",
  });

  expect(tool?.name).toBe(toolNameFor(ref));
  await tool?.execute({ query: "me" });
  expect(calls).toEqual([
    { ref, args: { query: "me" }, botId: "bot-1", actorId: "actor-1" },
  ]);
});

test("guidance groups a safe alias by its raw server and action", () => {
  const ref = "oomol.server/github.get_current_user";

  const guidance = grantedToolGuidance([guidanceTool(ref)]);

  expect(guidance).toContain("- oomol.server: github.get_current_user");
  expect(guidance).not.toContain("mcp_h");
});

test("guidance lists each connected-but-not-held system once", () => {
  const guidance = grantedToolGuidance(
    [],
    ["slack", "slack", "notion", "slack"],
  );

  expect(guidance).toContain(
    "This deployment also connects to: slack, notion. You hold none of their tools.",
  );
  expect(guidance.match(/This deployment also connects to:/g)).toHaveLength(1);
});
