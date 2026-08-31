import { afterEach, describe, expect, test } from "bun:test";
import { ARTIFACT_RESULT_SCHEMA } from "../../shared/artifact-contract";
import type { ArtifactTools } from "../src/artifacts/service";
import {
  callTool,
  listTools,
  useArtifactTools,
} from "../src/plugins/builtin-artifacts";

const connection = {
  url: "builtin://artifacts",
  actorId: "actor-a",
  botId: "bot-a",
  runId: "run-a",
  threadId: "thread-a",
};

afterEach(() => useArtifactTools(null));

describe("built-in artifact transport", () => {
  test("advertises one bounded mutually-exclusive create contract", async () => {
    const [tool] = await listTools();

    expect(tool?.name).toBe("create_artifact");
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    expect(tool?.inputSchema.required).toEqual([
      "title",
      "filename",
      "mimeType",
    ]);
    expect(tool?.inputSchema.oneOf).toHaveLength(2);
  });

  test("passes only trusted connection identity to the installed service", async () => {
    let received: unknown;
    const tools = {
      async createArtifact(context, args) {
        received = { context, args };
        return {
          ok: true as const,
          value: {
            schema: ARTIFACT_RESULT_SCHEMA,
            artifact: {
              attachmentId: "10000000-0000-4000-8000-000000000001",
              filename: "report.pdf",
              mimeType: "application/pdf" as const,
              size: 42,
              title: "Report",
            },
          },
        };
      },
    } satisfies ArtifactTools;
    useArtifactTools(tools);

    const result = await callTool(connection, "create_artifact", {
      title: "Report",
      filename: "report.pdf",
      mimeType: "application/pdf",
      content: "# Report",
      actorId: "forged",
      channelId: "forged",
    });

    expect(received).toEqual({
      context: {
        actorId: "actor-a",
        botId: "bot-a",
        runId: "run-a",
        threadId: "thread-a",
      },
      args: {
        title: "Report",
        filename: "report.pdf",
        mimeType: "application/pdf",
        content: "# Report",
        actorId: "forged",
        channelId: "forged",
      },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).schema).toBe(ARTIFACT_RESULT_SCHEMA);
  });

  test("fails closed without a signed run or installed service", async () => {
    expect(
      JSON.parse(
        (
          await callTool(
            { ...connection, runId: undefined },
            "create_artifact",
            {},
          )
        ).text,
      ).error.code,
    ).toBe("MISSING_TRUSTED_CONTEXT");
    expect(
      JSON.parse((await callTool(connection, "create_artifact", {})).text).error
        .code,
    ).toBe("CAPABILITY_UNAVAILABLE");
  });

  test("marks service errors and unknown tools as tool errors", async () => {
    useArtifactTools({
      async createArtifact() {
        return {
          ok: false,
          error: { code: "INVALID_ARGUMENT", message: "Invalid." },
        };
      },
    });

    expect((await callTool(connection, "create_artifact", {})).isError).toBe(
      true,
    );
    expect((await callTool(connection, "invented", {})).isError).toBe(true);
  });
});
