import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";
import type { AttachmentBlobStore } from "./blob-store";
import type {
  AttachmentListQuery,
  AttachmentRecord,
  AttachmentSource,
  AttachmentStore,
} from "./store";

const MAX_TOOL_PAGE_SIZE = 50;
const MAX_ACTOR_OR_BOT_ID_CODE_UNITS = 255;
const MAX_THREAD_ID_CODE_UNITS = 4_096;

/**
 * Context authenticated by the agent callback token. Tool arguments must never
 * be allowed to populate or override any of these fields.
 */
export type TrustedAttachmentToolContext = Readonly<{
  actorId: string;
  botId: string;
  threadId: string;
}>;

/** Content-free metadata safe to serialize into a model tool response. */
export type ConversationAttachmentMetadata = Readonly<{
  id: string;
  messageId: string | null;
  name: string;
  mimeType: string;
  size: number;
  source: AttachmentSource;
  createdAt: string;
}>;

export type ConversationAttachmentPage = Readonly<{
  attachments: ConversationAttachmentMetadata[];
  nextCursor: string | null;
}>;

export type ConversationAttachmentTextSource = Readonly<{
  attachment: ConversationAttachmentMetadata;
  openStream(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}>;

/**
 * Internal authorization seam used by the public tool facade. It deliberately
 * exposes neither a channel id nor an attachment storage key.
 */
export type ConversationAttachmentToolStore = Readonly<{
  list(
    context: TrustedAttachmentToolContext,
    query?: AttachmentListQuery,
  ): Promise<ConversationAttachmentPage | null>;
  metadata(
    context: TrustedAttachmentToolContext,
    attachmentId: string,
  ): Promise<ConversationAttachmentMetadata | null>;
  textSource(
    context: TrustedAttachmentToolContext,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<ConversationAttachmentTextSource | null>;
}>;

type ToolStoreOptions = {
  database: Database;
  metadata: Pick<AttachmentStore, "get" | "list">;
  blobs: Pick<AttachmentBlobStore, "open">;
};

type AuthorizedChannelRow = { channelId: string };

function safeMetadata(
  record: AttachmentRecord,
): ConversationAttachmentMetadata {
  return {
    id: record.id,
    messageId: record.messageId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    source: record.source,
    createdAt: record.createdAt.toISOString(),
  };
}

function validContextField(value: string, maxCodeUnits: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxCodeUnits &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  );
}

function validContext(context: TrustedAttachmentToolContext): boolean {
  return (
    validContextField(context.actorId, MAX_ACTOR_OR_BOT_ID_CODE_UNITS) &&
    validContextField(context.botId, MAX_ACTOR_OR_BOT_ID_CODE_UNITS) &&
    validContextField(context.threadId, MAX_THREAD_ID_CODE_UNITS)
  );
}

function boundedLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  return Math.min(MAX_TOOL_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

/**
 * Resolve the conversation from all three signed identities. The caller never
 * supplies a channel id, and a bot merely knowing an attachment UUID is not
 * sufficient: user membership, bot membership, thread mapping and live channel
 * must all agree before the ordinary owner-scoped AttachmentStore is reached.
 */
export function createConversationAttachmentToolStore({
  database,
  metadata,
  blobs,
}: ToolStoreOptions): ConversationAttachmentToolStore {
  async function authorizedChannel(
    context: TrustedAttachmentToolContext,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!validContext(context)) return null;
    signal?.throwIfAborted();

    const [row] = await database.execute<AuthorizedChannelRow>(sql`
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
    signal?.throwIfAborted();
    return row?.channelId ?? null;
  }

  async function authorizedAttachment(
    context: TrustedAttachmentToolContext,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<AttachmentRecord | null> {
    const channelId = await authorizedChannel(context, signal);
    if (!channelId) return null;
    const record = await metadata.get(context.actorId, channelId, attachmentId);
    signal?.throwIfAborted();
    return record;
  }

  return Object.freeze({
    async list(context, query = {}) {
      const channelId = await authorizedChannel(context);
      if (!channelId) return null;
      const page = await metadata.list(context.actorId, channelId, {
        ...query,
        limit: boundedLimit(query.limit),
      });
      return {
        attachments: page.attachments.map(safeMetadata),
        nextCursor: page.nextCursor,
      };
    },

    async metadata(context, attachmentId) {
      const record = await authorizedAttachment(context, attachmentId);
      return record ? safeMetadata(record) : null;
    },

    async textSource(context, attachmentId, signal) {
      const record = await authorizedAttachment(context, attachmentId, signal);
      if (!record) return null;
      return Object.freeze({
        attachment: safeMetadata(record),
        async openStream(readSignal?: AbortSignal) {
          readSignal?.throwIfAborted();
          const stream = await blobs.open(record.storageKey);
          if (readSignal?.aborted) {
            await stream.cancel(readSignal.reason).catch(() => undefined);
            throw readSignal.reason;
          }
          return stream;
        },
      });
    },
  });
}
