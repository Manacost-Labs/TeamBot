import { describe, expect, test } from "bun:test";
import { agentFormSchema } from "./form";
import { AGENT_TEMPLATES, agentTemplateValues } from "./templates";

describe("employee templates", () => {
  test("ships the eight product templates as ordinary valid form defaults", () => {
    expect(AGENT_TEMPLATES.map((template) => template.id)).toEqual([
      "researcher",
      "editor",
      "developer",
      "data-monitor",
      "seo",
      "designer",
      "support",
      "general-assistant",
    ]);
    for (const template of AGENT_TEMPLATES) {
      expect(agentFormSchema.safeParse(template.values).success).toBe(true);
      expect(template.values.endpoint).toBe("");
      expect(template.values.authValue).toBe("");
    }
  });

  test("returns a fresh blank form for an unknown template", () => {
    const first = agentTemplateValues("missing");
    const second = agentTemplateValues("missing");
    first.name = "changed";
    expect(second.name).toBe("");
  });
});
