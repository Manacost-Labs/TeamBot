import { describe, expect, test } from "bun:test";
import {
  groupOomolTools,
  oomolReadiness,
  oomolRecoveryHint,
} from "./oomol-readiness";
import type { PluginServer, PluginTool } from "./queries";

const tool = (name: string, grantedTo: string[] = []): PluginTool => ({
  serverId: "oomol-connector",
  name,
  ref: `oomol-connector/${name}`,
  description: "",
  inputSchema: {},
  effect: "write",
  grantedTo,
});
const server: PluginServer = {
  id: "oomol-connector",
  title: "OOMOL Connector",
  vendor: "OOMOL",
  url: "https://connector.oomol.com/v1",
  summary: "",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: "2026-09-05T10:00:00Z",
  lastError: null,
  addedBy: null,
  dynamicClient: false,
  tools: [tool("github.get_current_user")],
  withdrawn: [],
};
const roster = {
  agents: [{ id: "bot-1", hasCallbackToken: false }],
  botsMayCallBack: true,
};

describe("OOMOL readiness projection", () => {
  test("distinguishes no setup, a missing key, and a key never checked", () => {
    expect(oomolReadiness(undefined)).toBe("not-configured");
    expect(oomolReadiness({ ...server, hasCredential: false })).toBe(
      "missing-key",
    );
    expect(oomolReadiness({ ...server, toolsRefreshedAt: null })).toBe(
      "unchecked",
    );
    expect(oomolReadiness({ ...server, toolsRefreshedAt: "not-a-date" })).toBe(
      "unchecked",
    );
  });
  test("a cached action list does not hide discovery failure, even after HTTP 200", () => {
    expect(
      oomolReadiness({ ...server, lastError: "OOMOL rejected key (401)." }),
    ).toBe("failed");
    expect(oomolReadiness(server, { error: new Error("Request failed") })).toBe(
      "failed",
    );
  });
  test("refreshing supersedes old errors without claiming success", () => {
    expect(
      oomolReadiness({ ...server, lastError: "old" }, { refreshing: true }),
    ).toBe("checking");
  });
  test("empty successful discovery is not a failed or never-run check", () => {
    expect(oomolReadiness({ ...server, tools: [] })).toBe("empty");
  });
  test("discovery and tool grants remain separate facts", () => {
    expect(oomolReadiness(server, roster)).toBe("needs-grants");
    expect(
      oomolReadiness(
        {
          ...server,
          tools: [tool("github.get_current_user", ["bot-1"])],
        },
        roster,
      ),
    ).toBe("catalogued");
    expect(
      oomolReadiness(
        {
          ...server,
          withdrawn: [{ name: "old", ref: "old", grantedTo: ["bot-1"] }],
        },
        roster,
      ),
    ).toBe("needs-grants");
  });
  test("recorded grants require shared or per-agent callback configuration", () => {
    const granted = { ...server, tools: [tool("github.read", ["bot-1"])] };
    const agents = [{ id: "bot-1", hasCallbackToken: false }];
    expect(oomolReadiness(granted, { agents, botsMayCallBack: false })).toBe(
      "callback-needed",
    );
    expect(oomolReadiness(granted, { agents, botsMayCallBack: true })).toBe(
      "catalogued",
    );
    expect(
      oomolReadiness(granted, {
        agents: [{ id: "bot-1", hasCallbackToken: true }],
        botsMayCallBack: false,
      }),
    ).toBe("catalogued");
  });
  test("a partially configured group is not reported as fully configured", () => {
    expect(
      oomolReadiness(
        { ...server, tools: [tool("github.read", ["a", "b"])] },
        {
          agents: [
            { id: "a", hasCallbackToken: true },
            { id: "b", hasCallbackToken: false },
          ],
          botsMayCallBack: false,
        },
      ),
    ).toBe("callback-partial");
  });
  test("unresolved grant IDs cannot establish access for visible agents", () => {
    expect(
      oomolReadiness(
        { ...server, tools: [tool("github.read", ["unresolved"])] },
        {
          agents: [{ id: "bot-1", hasCallbackToken: true }],
          botsMayCallBack: true,
        },
      ),
    ).toBe("needs-grants");
    expect(oomolReadiness(server)).toBe("roster-unavailable");
  });
});

describe("OOMOL catalogue groups", () => {
  test("counts visible grantees separately from unresolved recorded IDs", () => {
    const groups = groupOomolTools(
      [tool("github.read", ["a", "unresolved"])],
      [{ id: "a", hasCallbackToken: true }],
    );
    expect(groups[0]?.grantedAgentCount).toBe(1);
    expect(groups[0]?.unresolvedAgentCount).toBe(1);
  });
  test("groups real provider prefixes and counts unique agents per group", () => {
    expect(
      groupOomolTools(
        [
          tool("googlesheets.get_spreadsheet"),
          tool("github.get_current_user", ["a", "b"]),
          tool("googledocs.get_document"),
          tool("github.list_repos", ["a"]),
        ],
        [
          { id: "a", hasCallbackToken: false },
          { id: "b", hasCallbackToken: false },
        ],
      ),
    ).toMatchObject([
      { id: "github", title: "GitHub", toolCount: 2, grantedAgentCount: 2 },
      {
        id: "googledocs",
        title: "Google Docs",
        toolCount: 1,
        grantedAgentCount: 0,
      },
      {
        id: "googlesheets",
        title: "Google Sheets",
        toolCount: 1,
        grantedAgentCount: 0,
      },
    ]);
  });
  test("never invents missing services and safely retains unknown action groups", () => {
    expect(
      groupOomolTools([
        tool("acme.read"),
        tool("opaque-action"),
        tool("__proto__.read"),
      ]),
    ).toMatchObject([
      { id: "acme", title: "acme", toolCount: 1, grantedAgentCount: 0 },
      {
        id: "other",
        title: "Другие действия",
        toolCount: 2,
        grantedAgentCount: 0,
      },
    ]);
    expect(groupOomolTools([])).toEqual([]);
  });
});

describe("OOMOL recovery guidance", () => {
  test("offers different next steps for key, permissions, throttling and network failures", () => {
    expect(oomolRecoveryHint("rejected (401)")).toContain("ключ");
    expect(oomolRecoveryHint("denied (403)")).toContain("команд");
    expect(oomolRecoveryHint("rate-limiting (429)")).toContain("позже");
    expect(oomolRecoveryHint("did not answer in time")).toContain("повторите");
  });
  test("does not echo unknown server messages or credential-like values", () => {
    const hint = oomolRecoveryHint(
      "Internal error: api_fixture_not_a_real_key <script>alert(1)</script>",
    );
    expect(hint).not.toContain("api_fixture");
    expect(hint).not.toContain("<script>");
  });
});
