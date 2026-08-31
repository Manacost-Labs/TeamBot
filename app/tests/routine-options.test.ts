import { describe, expect, test } from "bun:test";
import {
  routineAgentOptions,
  routineChannelOptions,
} from "../src/lib/routines/options";

describe("human-readable routine editor options", () => {
  test("labels employees by name and role instead of exposing only ids", () => {
    expect(
      routineAgentOptions([
        { id: "bot_2", name: "Researcher", title: "Market intelligence" },
        { id: "bot_1", name: "Editor", title: "Chief editor" },
      ]),
    ).toEqual([
      { value: "bot_1", label: "Editor — Chief editor" },
      { value: "bot_2", label: "Researcher — Market intelligence" },
    ]);
  });

  test("shows only active channels that contain the selected employee and disambiguates duplicate names", () => {
    expect(
      routineChannelOptions(
        [
          {
            id: "channel_alpha",
            name: "Content",
            agentIds: ["editor"],
            active: true,
          },
          {
            id: "channel_beta",
            name: "Content",
            agentIds: ["editor", "researcher"],
            active: true,
          },
          {
            id: "channel_gone",
            name: "Old content",
            agentIds: ["editor"],
            active: false,
          },
          {
            id: "channel_research",
            name: "Research",
            agentIds: ["researcher"],
            active: true,
          },
        ],
        "editor",
      ),
    ).toEqual([
      { value: "channel_alpha", label: "Content · channel_alpha" },
      { value: "channel_beta", label: "Content · channel_beta" },
    ]);
  });
});
