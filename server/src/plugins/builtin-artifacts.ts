import type { ArtifactToolContext, ArtifactTools } from "../artifacts/service";
import type { McpCallResult, McpTool } from "./mcp";
import type { VendorToolConnection } from "./transport";

const CREATE_ARTIFACT: McpTool = Object.freeze({
  name: "create_artifact",
  description:
    "Create a durable file card in this conversation. Supported outputs are Markdown (.md), plain text (.txt), JSON (.json), CSV (.csv), SVG (.svg), HTML (.html) and PDF (.pdf). For application/pdf only, provide Markdown content for the isolated renderer. JSON must be valid. HTML and SVG previews are shown as inert source text. Provide inline content; workspacePath is accepted only when this deployment later enables governed workspace export.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      filename: { type: "string", minLength: 1, maxLength: 255 },
      mimeType: {
        type: "string",
        enum: [
          "text/markdown",
          "text/plain",
          "application/json",
          "text/csv",
          "image/svg+xml",
          "text/html",
          "application/pdf",
        ],
      },
      content: { type: "string", minLength: 1, maxLength: 1_048_576 },
      workspacePath: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    required: ["title", "filename", "mimeType"],
    oneOf: [
      { required: ["content"], not: { required: ["workspacePath"] } },
      { required: ["workspacePath"], not: { required: ["content"] } },
    ],
  },
});

let installed: ArtifactTools | null = null;

/** Install once composition has storage and authorization; null keeps partial boots fail-closed. */
export function useArtifactTools(tools: ArtifactTools | null): void {
  installed = tools;
}

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return [{ ...CREATE_ARTIFACT }];
}

function contextOf(
  connection: VendorToolConnection,
): ArtifactToolContext | null {
  if (
    !connection.actorId ||
    !connection.botId ||
    typeof connection.runId !== "string" ||
    connection.runId.length === 0 ||
    typeof connection.threadId !== "string" ||
    connection.threadId.length === 0
  ) {
    return null;
  }
  return {
    actorId: connection.actorId,
    botId: connection.botId,
    runId: connection.runId,
    threadId: connection.threadId,
  };
}

function response(value: unknown, isError = false): McpCallResult {
  return {
    text: JSON.stringify(value),
    isError,
    truncated: false,
  };
}

export async function callTool(
  connection: VendorToolConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (toolName !== CREATE_ARTIFACT.name) {
    return response(
      {
        ok: false,
        error: {
          code: "UNKNOWN_TOOL",
          message: "That artifact tool is not available.",
        },
      },
      true,
    );
  }
  const context = contextOf(connection);
  if (!context) {
    return response(
      {
        ok: false,
        error: {
          code: "MISSING_TRUSTED_CONTEXT",
          message: "Artifact creation requires a trusted conversation run.",
        },
      },
      true,
    );
  }
  if (!installed) {
    return response(
      {
        ok: false,
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message: "Artifact creation is temporarily unavailable.",
        },
      },
      true,
    );
  }

  const result = await installed.createArtifact(context, args);
  return result.ok ? response(result.value) : response(result, true);
}
