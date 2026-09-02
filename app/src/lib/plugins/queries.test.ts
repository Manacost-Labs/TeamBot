import { describe, expect, test } from "bun:test";
import { projectPluginConnectionHealth } from "./queries";

describe("plugin connection health projection", () => {
  test("keeps only the small availability and connection shape", () => {
    expect(
      projectPluginConnectionHealth({
        available: [{ serverId: "google-drive", title: "Google Drive" }],
        connected: [
          {
            serverId: "google-drive",
            connectedAt: "2026-09-01T10:00:00.000Z",
          },
        ],
        tools: [{ name: "must-not-reach-the-page" }],
      }),
    ).toEqual({
      available: [{ serverId: "google-drive", title: "Google Drive" }],
      connected: [
        {
          serverId: "google-drive",
          connectedAt: "2026-09-01T10:00:00.000Z",
        },
      ],
    });
  });

  test("rejects malformed rows instead of treating them as no connections", () => {
    expect(() =>
      projectPluginConnectionHealth({
        available: [{ serverId: "google-drive" }],
        connected: [],
      }),
    ).toThrow("invalid response");
    expect(() =>
      projectPluginConnectionHealth({
        available: [],
        connected: [null],
      }),
    ).toThrow("invalid response");
  });
});
