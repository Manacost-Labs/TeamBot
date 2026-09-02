import { describe, expect, test } from "bun:test";
import type { WorkspaceArtifactMetadata } from "@/lib/artifacts/api";
import { filterWorkspaceArtifacts } from "./results";

const artifacts = [
  {
    id: "a",
    channelId: "channel-a",
    filename: "research.md",
    mimeType: "text/markdown",
    size: 10,
    messageId: "artifact:a",
    source: "agent_generated",
    createdAt: "2026-08-30T12:00:00.000Z",
  },
  {
    id: "b",
    channelId: "channel-b",
    filename: "table.csv",
    mimeType: "text/csv",
    size: 20,
    messageId: "artifact:b",
    source: "agent_generated",
    createdAt: "2026-08-30T11:00:00.000Z",
  },
] satisfies WorkspaceArtifactMetadata[];

describe("results filters", () => {
  test("filters by type and filename without mutating the server order", () => {
    expect(
      filterWorkspaceArtifacts(artifacts, "text/markdown", "research"),
    ).toEqual([artifacts[0]]);
    expect(filterWorkspaceArtifacts(artifacts, "all", "CSV")).toEqual([
      artifacts[1],
    ]);
    expect(filterWorkspaceArtifacts(artifacts, "all", "")).toEqual(artifacts);
  });
});
