import { afterEach, describe, expect, test } from "bun:test";
import type { ConversationAttachmentTools } from "../src/attachments/tool-facade";
import {
  callTool,
  listTools,
  useConversationAttachmentTools,
} from "../src/plugins/builtin-conversation-attachments";

const CONNECTION = {
  url: "builtin://attachments",
  actorId: "signed-actor",
  botId: "signed-bot",
  runId: "signed-run",
  threadId: "signed-thread",
};

afterEach(() => useConversationAttachmentTools(null));

function installedRecorder(calls: unknown[]): ConversationAttachmentTools {
  return {
    async listConversationAttachments(context, args) {
      calls.push({ method: "list", context, args });
      return { ok: true, value: { attachments: [], nextCursor: null } };
    },
    async readAttachmentMetadata(context, args) {
      calls.push({ method: "metadata", context, args });
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "Not found." },
      };
    },
    async readAttachmentText(context, args) {
      calls.push({ method: "text", context, args });
      return {
        ok: false,
        error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Not text." },
      };
    },
  };
}

describe("the governed conversation attachment transport", () => {
  test("advertises only the three installed conversation-scoped tools", async () => {
    const tools = await listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "list_conversation_attachments",
      "read_attachment_metadata",
      "read_attachment_text",
    ]);
    expect(tools.map((tool) => tool.description).join("\n")).not.toMatch(
      /image|vision/iu,
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        unknown
      >;
      expect(properties.actorId).toBeUndefined();
      expect(properties.botId).toBeUndefined();
      expect(properties.runId).toBeUndefined();
      expect(properties.threadId).toBeUndefined();
      expect(properties.channelId).toBeUndefined();
    }
    expect(tools[2]?.inputSchema).toMatchObject({
      properties: {
        cursor: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 24_000 },
      },
      required: ["attachmentId"],
    });
  });

  test("passes only the trusted connection identity beside untrusted arguments", async () => {
    const calls: unknown[] = [];
    useConversationAttachmentTools(installedRecorder(calls));
    const spoofed = {
      cursor: "next",
      limit: 12,
      actorId: "forged-actor",
      botId: "forged-bot",
      threadId: "forged-thread",
      channelId: "forged-channel",
    };

    const result = await callTool(
      CONNECTION,
      "list_conversation_attachments",
      spoofed,
    );

    expect(JSON.parse(result.text)).toEqual({
      ok: true,
      value: { attachments: [], nextCursor: null },
    });
    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      {
        method: "list",
        context: {
          actorId: "signed-actor",
          botId: "signed-bot",
          threadId: "signed-thread",
        },
        args: spoofed,
      },
    ]);
  });

  test("refuses a call with no trusted thread before reaching the facade", async () => {
    const calls: unknown[] = [];
    useConversationAttachmentTools(installedRecorder(calls));

    const result = await callTool(
      { ...CONNECTION, threadId: undefined },
      "read_attachment_metadata",
      { attachmentId: "00000000-0000-4000-8000-000000000001" },
    );

    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: { code: "MISSING_TRUSTED_CONTEXT" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("returns facade results as stable JSON envelopes", async () => {
    const calls: unknown[] = [];
    useConversationAttachmentTools(installedRecorder(calls));

    const metadata = await callTool(CONNECTION, "read_attachment_metadata", {
      attachmentId: "00000000-0000-4000-8000-000000000001",
    });
    const text = await callTool(CONNECTION, "read_attachment_text", {
      attachmentId: "00000000-0000-4000-8000-000000000001",
      cursor: 0,
      maxChars: 200,
    });

    expect(JSON.parse(metadata.text)).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Not found." },
    });
    expect(JSON.parse(text.text)).toEqual({
      ok: false,
      error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Not text." },
    });
    expect(metadata.isError).toBe(false);
    expect(text.isError).toBe(false);
  });

  test("does not advertise image reading and rejects a direct call fail-closed", async () => {
    const result = await callTool(CONNECTION, "get_image_attachment", {
      attachmentId: "00000000-0000-4000-8000-000000000001",
      question: "What is shown?",
    });
    const envelope = JSON.parse(result.text);

    expect(envelope).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).not.toMatch(/base64|storageKey|https?:\/\//iu);
  });
});
