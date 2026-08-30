import type { ConversationAttachmentTools } from "../attachments/tool-facade";
import type { TrustedAttachmentToolContext } from "../attachments/tool-store";
import type { McpCallResult, McpTool } from "./mcp";
import type { VendorToolConnection } from "./transport";

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_conversation_attachments",
    description:
      "List the files attached to this conversation. Use the returned opaque attachment ids with the metadata and text tools; never ask for a filesystem path or download URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "string", minLength: 1, maxLength: 4_096 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "read_attachment_metadata",
    description:
      "Read safe metadata for one attachment in this conversation by its opaque id. Returns no storage path, token, file bytes or download URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachmentId: { type: "string", format: "uuid" },
      },
      required: ["attachmentId"],
    },
  },
  {
    name: "read_attachment_text",
    description:
      "Read one bounded page of UTF-8 text from an attachment in this conversation. Follow nextCursor to continue; unsupported files are reported explicitly.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachmentId: { type: "string", format: "uuid" },
        cursor: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 24_000 },
      },
      required: ["attachmentId"],
    },
  },
]);

const MISSING_TRUSTED_CONTEXT = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "MISSING_TRUSTED_CONTEXT",
    message: "This attachment tool requires a trusted conversation context.",
  }),
});

const CAPABILITY_UNAVAILABLE = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "CAPABILITY_UNAVAILABLE",
    message: "Conversation attachment tools are not installed.",
  }),
});

const UNKNOWN_TOOL = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "UNKNOWN_TOOL",
    message: "That conversation attachment tool is not available.",
  }),
});

let installed: ConversationAttachmentTools | null = null;

/** Install the authorization facade once stores exist; null keeps tests and partial boots fail-closed. */
export function useConversationAttachmentTools(
  tools: ConversationAttachmentTools | null,
): void {
  installed = tools;
}

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

function result(envelope: unknown, isError = false): McpCallResult {
  return {
    text: JSON.stringify(envelope),
    isError,
    truncated: false,
  };
}

function trustedContext(
  connection: VendorToolConnection,
): TrustedAttachmentToolContext | null {
  if (
    !connection.actorId ||
    !connection.botId ||
    typeof connection.threadId !== "string" ||
    connection.threadId.length === 0
  ) {
    return null;
  }
  return {
    actorId: connection.actorId,
    botId: connection.botId,
    threadId: connection.threadId,
  };
}

export async function callTool(
  connection: VendorToolConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!TOOLS.some((tool) => tool.name === toolName)) {
    return result(UNKNOWN_TOOL, true);
  }

  const context = trustedContext(connection);
  if (!context) return result(MISSING_TRUSTED_CONTEXT, true);

  if (!installed) return result(CAPABILITY_UNAVAILABLE);

  switch (toolName) {
    case "list_conversation_attachments":
      return result(await installed.listConversationAttachments(context, args));
    case "read_attachment_metadata":
      return result(await installed.readAttachmentMetadata(context, args));
    case "read_attachment_text":
      return result(await installed.readAttachmentText(context, args));
    default:
      return result(UNKNOWN_TOOL, true);
  }
}
