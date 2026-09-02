import { describe, expect, test } from "bun:test";
import {
  projectPluginConnectionHealth,
  projectPluginConnections,
} from "./queries";

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

describe("plugin connections projection", () => {
  test("keeps only personal connection metadata and redirect target", () => {
    expect(
      projectPluginConnections({
        connections: [
          {
            serverId: "google-drive",
            scope: "drive.readonly",
            connectedAt: "2026-09-01T10:00:00.000Z",
            refreshToken: "must-not-reach-the-page",
          },
        ],
        redirectUri:
          "https://work.kolodahearthstone.com/api/plugins/oauth/callback",
        credentials: [{ secret: "must-not-reach-the-page" }],
      }),
    ).toEqual({
      connections: [
        {
          serverId: "google-drive",
          scope: "drive.readonly",
          connectedAt: "2026-09-01T10:00:00.000Z",
        },
      ],
      redirectUri:
        "https://work.kolodahearthstone.com/api/plugins/oauth/callback",
    });
  });

  test("rejects malformed rows instead of showing an account as disconnected", () => {
    expect(() =>
      projectPluginConnections({
        connections: [{ serverId: "google-drive", scope: "drive.readonly" }],
        redirectUri: null,
      }),
    ).toThrow("invalid response");
    expect(() =>
      projectPluginConnections({ connections: [], redirectUri: 42 }),
    ).toThrow("invalid response");
  });
});
