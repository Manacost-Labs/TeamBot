import { describe, expect, test } from "bun:test";
import { groupAgentsByFolder } from "@/lib/agents/grouping";
import {
  agentFormSchema,
  agentInputFrom,
  emptyAgentForm,
} from "@/lib/agents/form";
import { agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";

describe("coworker query keys", () => {
  test("separates the visible roster from the hidden one", () => {
    expect(agentKeys.list()).toEqual(["agents", "list", { hidden: false }]);
    expect(agentKeys.list(true)).toEqual(["agents", "list", { hidden: true }]);
    // Both lists and every profile sit under one prefix, so a mutation can invalidate all of them.
    expect(agentKeys.detail("agent_1")[0]).toBe(agentKeys.all[0]);
    expect(channelKeys.detail("channel_1")).toEqual([
      "channels",
      "detail",
      "channel_1",
    ]);
  });
});

describe("coworker folders", () => {
  test("groups named folders first and puts empty folders last", () => {
    const base = {
      name: "Agent",
      title: "Role",
      roleDescription: "Description",
      avatarSeed: "seed",
      visibility: "private" as const,
      endpoint: null,
      hasAuth: false,
      model: null,
      reasoningEffort: null,
      reasoningCeiling: null,
      hasCallbackToken: false,
      hidden: false,
      systemOwned: false,
      canManage: true,
      mine: true,
    };
    const groups = groupAgentsByFolder([
      { ...base, id: "unfiled" },
      { ...base, id: "editor", folder: "Редакция" },
      { ...base, id: "control", folder: "Технический контроль" },
      { ...base, id: "another-editor", folder: "Редакция" },
    ]);
    expect(groups.map((group) => group.folder)).toEqual([
      "Редакция",
      "Технический контроль",
      "Без папки",
    ]);
    expect(groups[0]?.agents.map((agent) => agent.id)).toEqual([
      "editor",
      "another-editor",
    ]);
  });
});

describe("coworker form validation", () => {
  test("accepts the fields a person fills in", () => {
    expect(
      agentFormSchema.parse({
        ...emptyAgentForm,
        name: "  Expense Manager  ",
        title: "Finance Operations",
        roleDescription: "Review receipts and prepare reimbursement reports.",
      }).name,
    ).toBe("Expense Manager");
  });

  test("an endpoint is optional, and must look like a web address", () => {
    const valid = {
      ...emptyAgentForm,
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
    };
    // Empty means the Bot in the box, which is what most people want first time.
    expect(agentFormSchema.safeParse({ ...valid, endpoint: "" }).success).toBe(
      true,
    );
    expect(
      agentFormSchema.safeParse({
        ...valid,
        endpoint: "https://agents.example.com/ag-ui",
      }).success,
    ).toBe(true);
    // Shape only. WHETHER an address is allowed is the server's decision, because it depends on the
    // deployment and a check that lives in a browser is a check an attacker skips.
    expect(
      agentFormSchema.safeParse({ ...valid, endpoint: "not a url" }).success,
    ).toBe(false);
  });

  test("rejects what the server would reject", () => {
    const valid = {
      ...emptyAgentForm,
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
    };

    expect(agentFormSchema.safeParse({ ...valid, name: "   " }).success).toBe(
      false,
    );
    expect(
      agentFormSchema.safeParse({ ...valid, name: "n".repeat(81) }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({ ...valid, title: "t".repeat(121) }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({
        ...valid,
        roleDescription: "r".repeat(1001),
      }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({ ...valid, visibility: "everyone" }).success,
    ).toBe(false);
  });

  test("accepts bounded model and reasoning overrides", () => {
    const valid = {
      ...emptyAgentForm,
      name: "Editor",
      title: "Chief editor",
      roleDescription: "Improve drafts and explain meaningful edits.",
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh" as const,
    };

    expect(agentFormSchema.safeParse(valid).success).toBe(true);
    expect(
      agentFormSchema.safeParse({ ...valid, model: "bad model" }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({
        ...valid,
        reasoningEffort: "unbounded",
      }).success,
    ).toBe(false);
    expect(agentInputFrom(valid)).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
    });
    expect(
      agentInputFrom({ ...valid, model: "", reasoningEffort: "" }),
    ).toMatchObject({
      model: null,
      reasoningEffort: null,
    });
  });
});
