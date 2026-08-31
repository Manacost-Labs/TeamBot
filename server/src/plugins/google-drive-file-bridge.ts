import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AttachmentUploadService } from "../attachments/lifecycle";
import type { AttachmentRecord, AttachmentStore } from "../attachments/store";
import type {
  ConversationAttachmentContentSource,
  ConversationAttachmentStore,
  TrustedAttachmentToolContext,
} from "../attachments/tool-store";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";

export const MAX_GOOGLE_BRIDGE_BYTES = 25 * 1024 * 1024;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_NAME_CODE_POINTS = 255;
const MAX_CONTEXT_CODE_UNITS = 4_096;

export type GoogleDriveBridgeContext = TrustedAttachmentToolContext &
  Readonly<{ runId: string }>;

export type ImportedGoogleAttachment = Readonly<{
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  source: "google_export";
}>;

export type GoogleUploadAttachmentSource = ConversationAttachmentContentSource;

export type GoogleDriveBridgeResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; message: string }>;

type BridgeDependencies = Readonly<{
  database: Database;
  attachments: Pick<AttachmentStore, "list">;
  uploads: AttachmentUploadService;
  conversationAttachments: Pick<ConversationAttachmentStore, "contentSource">;
}>;

type AuthorizedChannelRow = { channelId: string };

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
  });
}

function validContextField(value: string, maxCodeUnits: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxCodeUnits &&
    !hasControl(value)
  );
}

function validContext(context: GoogleDriveBridgeContext): boolean {
  return (
    validContextField(context.actorId, 255) &&
    validContextField(context.botId, 255) &&
    validContextField(context.threadId, MAX_CONTEXT_CODE_UNITS) &&
    validContextField(context.runId, MAX_CONTEXT_CODE_UNITS)
  );
}

function safeImportedAttachment(
  record: AttachmentRecord,
): ImportedGoogleAttachment | null {
  if (
    record.source !== "google_export" ||
    record.size < 1 ||
    record.size > MAX_GOOGLE_BRIDGE_BYTES ||
    !Number.isSafeInteger(record.size) ||
    record.name.length === 0 ||
    [...record.name].length > MAX_NAME_CODE_POINTS ||
    hasControl(record.name) ||
    record.mimeType.length === 0 ||
    record.mimeType.length > 255 ||
    hasControl(record.mimeType)
  ) {
    return null;
  }
  return {
    attachmentId: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    source: "google_export",
  };
}

function importMessageId(operationId: string): string {
  return `google-import:v1:${operationId}`;
}

function bytesStreamCancelled(
  body: ReadableStream<Uint8Array>,
  reason: unknown,
): void {
  if (!body.locked) void body.cancel(reason).catch(() => undefined);
}

export function googleDriveOperationId(
  kind: "import" | "upload" | "create-folder" | "move",
  context: GoogleDriveBridgeContext,
  parts: readonly string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        kind,
        actorId: context.actorId,
        botId: context.botId,
        threadId: context.threadId,
        runId: context.runId,
        parts,
      }),
    )
    .digest("hex");
}

/** Trusted attachment and cross-replica idempotency boundary for Google Drive file operations. */
export function createGoogleDriveFileBridge(dependencies: BridgeDependencies) {
  async function authorizedChannel(
    context: GoogleDriveBridgeContext,
  ): Promise<string | null> {
    if (!validContext(context)) return null;
    const [row] = await dependencies.database.execute<AuthorizedChannelRow>(sql`
      select ${intelligenceChannelMappings.channelId} as "channelId"
      from ${intelligenceChannelMappings}
      inner join ${channelMemberships}
        on ${channelMemberships.channelId} = ${intelligenceChannelMappings.channelId}
        and ${channelMemberships.userId} = ${context.actorId}
      inner join ${channelAgents}
        on ${channelAgents.channelId} = ${intelligenceChannelMappings.channelId}
        and ${channelAgents.agentId} = ${context.botId}
      inner join ${channels}
        on ${channels.id} = ${intelligenceChannelMappings.channelId}
        and ${channels.deletedAt} is null
      where ${intelligenceChannelMappings.userId} = ${context.actorId}
        and ${intelligenceChannelMappings.threadId} = ${context.threadId}
      limit 1
    `);
    return row?.channelId ?? null;
  }

  async function recoveredImport(
    context: GoogleDriveBridgeContext,
    channelId: string,
    operationId: string,
  ): Promise<GoogleDriveBridgeResult<ImportedGoogleAttachment | null>> {
    const page = await dependencies.attachments.list(
      context.actorId,
      channelId,
      { messageId: importMessageId(operationId), limit: 10 },
    );
    const matches = page.attachments.flatMap((record) => {
      const safe = safeImportedAttachment(record);
      return safe ? [safe] : [];
    });
    if (matches.length > 1) {
      return {
        ok: false,
        message:
          "This Google Drive import has more than one stored result and was not guessed.",
      };
    }
    return { ok: true, value: matches[0] ?? null };
  }

  return Object.freeze({
    async withOperationLock<Value>(
      operationId: string,
      operation: () => Promise<Value>,
    ): Promise<Value> {
      return dependencies.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`,
        );
        return operation();
      });
    },

    async recoverImport(
      context: GoogleDriveBridgeContext,
      operationId: string,
    ): Promise<GoogleDriveBridgeResult<ImportedGoogleAttachment | null>> {
      const channelId = await authorizedChannel(context);
      return channelId
        ? recoveredImport(context, channelId, operationId)
        : {
            ok: false,
            message:
              "This conversation is not available for a Google Drive import.",
          };
    },

    async publishImport(
      context: GoogleDriveBridgeContext,
      input: Readonly<{
        operationId: string;
        name: string;
        mimeType: string;
        body: ReadableStream<Uint8Array>;
      }>,
    ): Promise<GoogleDriveBridgeResult<ImportedGoogleAttachment>> {
      const channelId = await authorizedChannel(context);
      if (!channelId) {
        bytesStreamCancelled(input.body, new Error("Conversation unavailable"));
        return {
          ok: false,
          message:
            "This conversation is not available for a Google Drive import.",
        };
      }
      const recovered = await recoveredImport(
        context,
        channelId,
        input.operationId,
      );
      if (!recovered.ok) {
        bytesStreamCancelled(input.body, new Error("Import is ambiguous"));
        return recovered;
      }
      if (recovered.value) {
        bytesStreamCancelled(input.body, new Error("Import already exists"));
        return { ok: true, value: recovered.value };
      }

      try {
        const reservation = await dependencies.uploads.reserve(
          context.actorId,
          channelId,
        );
        if (!reservation) {
          bytesStreamCancelled(input.body, new Error("Import unavailable"));
          return {
            ok: false,
            message: "The Google Drive file could not be stored right now.",
          };
        }
        const record = await dependencies.uploads.upload(
          context.actorId,
          channelId,
          "google_export",
          reservation,
          {
            messageId: importMessageId(input.operationId),
            name: input.name,
            mimeType: input.mimeType,
          },
          input.body,
        );
        const safe = record ? safeImportedAttachment(record) : null;
        return safe
          ? { ok: true, value: safe }
          : {
              ok: false,
              message: "The Google Drive file could not be stored safely.",
            };
      } catch {
        bytesStreamCancelled(input.body, new Error("Import failed"));
        return {
          ok: false,
          message: "The Google Drive file could not be stored safely.",
        };
      }
    },

    async attachmentForUpload(
      context: GoogleDriveBridgeContext,
      attachmentId: string,
      signal?: AbortSignal,
    ): Promise<GoogleDriveBridgeResult<GoogleUploadAttachmentSource>> {
      if (!UUID.test(attachmentId) || !validContext(context)) {
        return {
          ok: false,
          message: "That conversation attachment is not available.",
        };
      }
      const source = await dependencies.conversationAttachments.contentSource(
        context,
        attachmentId,
        signal,
      );
      if (
        !source ||
        source.attachment.size < 1 ||
        source.attachment.size > MAX_GOOGLE_BRIDGE_BYTES ||
        !Number.isSafeInteger(source.attachment.size) ||
        source.attachment.name.length === 0 ||
        [...source.attachment.name].length > MAX_NAME_CODE_POINTS ||
        hasControl(source.attachment.name) ||
        source.attachment.mimeType.length === 0 ||
        source.attachment.mimeType.length > 255 ||
        hasControl(source.attachment.mimeType)
      ) {
        return {
          ok: false,
          message: "That conversation attachment is not available.",
        };
      }
      return { ok: true, value: source };
    },
  });
}

export type GoogleDriveFileBridge = ReturnType<
  typeof createGoogleDriveFileBridge
>;
