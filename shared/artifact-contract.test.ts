import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_RESULT_SCHEMA,
  CREATE_ARTIFACT_TOOL_NAME,
  parseArtifactResult,
  parseArtifactToolResult,
} from "./artifact-contract";

const attachmentId = "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd";
const envelope = {
  schema: ARTIFACT_RESULT_SCHEMA,
  artifact: {
    attachmentId,
    filename: "report.md",
    mimeType: "text/markdown",
    size: 42,
    title: "Report",
  },
};

describe("artifact v1 tool-result contract", () => {
  test("projects a valid result onto the public fields", () => {
    expect(
      parseArtifactResult({
        ...envelope,
        privatePath: "/workspace/artifacts/report.md",
        artifact: { ...envelope.artifact, storageKey: "private/key" },
      }),
    ).toEqual(envelope);
  });

  test("accepts only the exact first-party tool name", () => {
    const result = JSON.stringify(envelope);
    expect(parseArtifactToolResult(CREATE_ARTIFACT_TOOL_NAME, result)).toEqual(
      envelope,
    );
    expect(
      parseArtifactToolResult(
        CREATE_ARTIFACT_TOOL_NAME,
        JSON.stringify(result),
      ),
    ).toEqual(envelope);
    expect(parseArtifactToolResult("mcp__other__create_artifact", result)).toBe(
      null,
    );
  });

  test("rejects malformed JSON, ids, MIME types and non-positive sizes", () => {
    expect(parseArtifactToolResult(CREATE_ARTIFACT_TOOL_NAME, "not-json")).toBe(
      null,
    );
    expect(
      parseArtifactResult({
        ...envelope,
        artifact: { ...envelope.artifact, attachmentId: "../../secret" },
      }),
    ).toBe(null);
    expect(
      parseArtifactResult({
        ...envelope,
        artifact: { ...envelope.artifact, mimeType: "text/html" },
      }),
    ).toBe(null);
    expect(
      parseArtifactResult({
        ...envelope,
        artifact: { ...envelope.artifact, size: 0 },
      }),
    ).toBe(null);
  });
});
