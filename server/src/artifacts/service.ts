import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  artifactFilenameMatchesMimeType,
  ARTIFACT_RESULT_SCHEMA,
  type ArtifactMimeType,
  type ArtifactResult,
  isArtifactMimeType,
} from "../../../shared/artifact-contract";
import type { AttachmentUploadService } from "../attachments/lifecycle";
import type { AttachmentRecord, AttachmentStore } from "../attachments/store";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";
import {
  type ArtifactExportClaim,
  type ArtifactExportStore,
  artifactAttachmentMessageId,
} from "./export-store";
import type { ArtifactRenderer } from "./renderer-client";

const MAX_INLINE_CONTENT_BYTES = 1024 * 1024;
const MAX_TITLE_CODE_POINTS = 200;
const MAX_FILENAME_CODE_POINTS = 255;
const MAX_WORKSPACE_PATH_CODE_UNITS = 4_096;
const MAX_JSON_DEPTH = 100;
const MAX_JSON_NODES = 100_000;
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export type ArtifactToolContext = Readonly<{
  actorId: string;
  botId: string;
  runId: string;
  threadId: string;
}>;

export type ArtifactToolErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "BUSY"
  | "CAPABILITY_UNAVAILABLE"
  | "UNAVAILABLE";

export type ArtifactToolResult =
  | Readonly<{ ok: true; value: ArtifactResult }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: ArtifactToolErrorCode; message: string }>;
    }>;

type CreateArtifactArgs = Readonly<{
  title: string;
  filename: string;
  mimeType: ArtifactMimeType;
  content?: string;
  workspacePath?: string;
}>;

type ArtifactServiceDependencies = Readonly<{
  database: Database;
  exports: ArtifactExportStore;
  attachments: Pick<AttachmentStore, "get" | "list">;
  uploads: AttachmentUploadService;
  renderer?: ArtifactRenderer;
}>;

type AuthorizedChannelRow = { channelId: string };

const failure = (
  code: ArtifactToolErrorCode,
  message: string,
): ArtifactToolResult => ({ ok: false, error: { code, message } });

const INVALID_ARGUMENT = failure(
  "INVALID_ARGUMENT",
  "Artifact arguments are invalid. Send exactly title, filename, mimeType and one non-empty inline content string; the filename extension must match the MIME type. Do not send workspacePath or extra fields.",
);
const NOT_FOUND = failure(
  "NOT_FOUND",
  "This conversation is not available for artifact creation.",
);
const BUSY = failure(
  "BUSY",
  "The same artifact is already being created. Retry shortly.",
);
const WORKSPACE_UNAVAILABLE = failure(
  "CAPABILITY_UNAVAILABLE",
  "Workspace artifact export is not available yet; provide inline content instead.",
);
const PDF_UNAVAILABLE = failure(
  "CAPABILITY_UNAVAILABLE",
  "PDF export is not configured on this deployment.",
);
const UNAVAILABLE = failure(
  "UNAVAILABLE",
  "The artifact could not be created right now.",
);

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
  });
}

function safeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized.length > 0 &&
    [...normalized].length <= MAX_TITLE_CODE_POINTS &&
    !hasControl(normalized)
    ? normalized
    : null;
}

function safeFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > MAX_FILENAME_CODE_POINTS ||
    hasControl(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    /^[a-z]:/iu.test(normalized) ||
    WINDOWS_RESERVED_NAME.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function validJsonContent(content: string): boolean {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return false;
  }

  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 1, value: root },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const value of Object.values(current.value)) {
      pending.push({ depth: current.depth + 1, value });
    }
  }
  return true;
}

export function parseCreateArtifactArgs(
  value: unknown,
): CreateArtifactArgs | null {
  if (
    !plainObject(value) ||
    !hasOnlyKeys(
      value,
      new Set(["title", "filename", "mimeType", "content", "workspacePath"]),
    )
  ) {
    return null;
  }
  const title = safeTitle(value.title);
  const filename = safeFilename(value.filename);
  if (!title || !filename) return null;
  const mimeType = value.mimeType;
  if (typeof mimeType !== "string" || !isArtifactMimeType(mimeType)) {
    return null;
  }
  if (!artifactFilenameMatchesMimeType(filename, mimeType)) return null;

  const hasContent = typeof value.content === "string";
  const hasWorkspacePath = typeof value.workspacePath === "string";
  if (hasContent === hasWorkspacePath) return null;
  if (
    value.content !== undefined &&
    value.content !== null &&
    typeof value.content !== "string"
  ) {
    return null;
  }
  if (
    value.workspacePath !== undefined &&
    value.workspacePath !== null &&
    typeof value.workspacePath !== "string"
  ) {
    return null;
  }

  if (hasContent) {
    const content = value.content as string;
    const size = Buffer.byteLength(content, "utf8");
    if (size < 1 || size > MAX_INLINE_CONTENT_BYTES) return null;
    if (mimeType === "application/json" && !validJsonContent(content)) {
      return null;
    }
    return { title, filename, mimeType, content };
  }

  const workspacePath = value.workspacePath as string;
  if (
    workspacePath.length < 1 ||
    workspacePath.length > MAX_WORKSPACE_PATH_CODE_UNITS ||
    hasControl(workspacePath)
  ) {
    return null;
  }
  return { title, filename, mimeType, workspacePath };
}

function fingerprint(args: CreateArtifactArgs): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: args.title,
        filename: args.filename,
        mimeType: args.mimeType,
        content: args.content ?? null,
        workspacePath: args.workspacePath ?? null,
      }),
    )
    .digest("hex");
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function artifactResult(
  title: string,
  attachment: AttachmentRecord,
): ArtifactToolResult {
  if (
    !isArtifactMimeType(attachment.mimeType) ||
    !artifactFilenameMatchesMimeType(attachment.name, attachment.mimeType)
  ) {
    return UNAVAILABLE;
  }
  return {
    ok: true,
    value: {
      schema: ARTIFACT_RESULT_SCHEMA,
      artifact: {
        attachmentId: attachment.id,
        filename: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        title,
      },
    },
  };
}

function validContextField(value: string, maxCodeUnits: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxCodeUnits &&
    !hasControl(value)
  );
}

async function authorizedChannel(
  database: Database,
  context: ArtifactToolContext,
): Promise<string | null> {
  if (
    !validContextField(context.actorId, 255) ||
    !validContextField(context.botId, 255) ||
    !validContextField(context.runId, 4_096) ||
    !validContextField(context.threadId, 4_096)
  ) {
    return null;
  }
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
  return row?.channelId ?? null;
}

async function storedArtifact(
  attachments: Pick<AttachmentStore, "get">,
  context: ArtifactToolContext,
  channelId: string,
  attachmentId: string,
): Promise<AttachmentRecord | null> {
  return attachments.get(context.actorId, channelId, attachmentId);
}

function matchesRequest(
  record: AttachmentRecord,
  args: CreateArtifactArgs,
  messageId: string,
): boolean {
  return (
    record.source === "agent_generated" &&
    record.messageId === messageId &&
    record.name === args.filename &&
    record.mimeType === args.mimeType
  );
}

async function recoverPublishedAttachment(
  dependencies: ArtifactServiceDependencies,
  context: ArtifactToolContext,
  channelId: string,
  claim: Extract<ArtifactExportClaim, { kind: "claimed" }>,
  args: CreateArtifactArgs,
): Promise<AttachmentRecord | null> {
  const page = await dependencies.attachments.list(context.actorId, channelId, {
    messageId: claim.messageId,
    limit: 10,
  });
  return (
    page.attachments.find((record) =>
      matchesRequest(record, args, claim.messageId),
    ) ?? null
  );
}

/** Governed create-artifact service shared by interactive, remote and scheduled Bot runs. */
export function createArtifactTools(dependencies: ArtifactServiceDependencies) {
  return Object.freeze({
    async createArtifact(
      context: ArtifactToolContext,
      rawArgs: unknown,
    ): Promise<ArtifactToolResult> {
      const args = parseCreateArtifactArgs(rawArgs);
      if (!args) return INVALID_ARGUMENT;
      if (args.workspacePath !== undefined) return WORKSPACE_UNAVAILABLE;
      if (args.mimeType === "application/pdf" && !dependencies.renderer) {
        return PDF_UNAVAILABLE;
      }

      let channelId: string | null;
      try {
        channelId = await authorizedChannel(dependencies.database, context);
      } catch {
        return UNAVAILABLE;
      }
      if (!channelId) return NOT_FOUND;

      const exportContext = {
        ownerUserId: context.actorId,
        channelId,
        botId: context.botId,
        runId: context.runId,
        fingerprint: fingerprint(args),
      };
      let claim: ArtifactExportClaim;
      try {
        claim = await dependencies.exports.claim(exportContext);
        if (claim.kind === "ready") {
          const record = await storedArtifact(
            dependencies.attachments,
            context,
            channelId,
            claim.attachmentId,
          );
          if (
            record &&
            matchesRequest(
              record,
              args,
              artifactAttachmentMessageId(claim.exportId),
            )
          ) {
            return artifactResult(args.title, record);
          }
          if (
            !(await dependencies.exports.invalidateReady(
              claim.exportId,
              claim.attachmentId,
            ))
          ) {
            return BUSY;
          }
          claim = await dependencies.exports.claim(exportContext);
        }
      } catch {
        return UNAVAILABLE;
      }
      if (claim.kind === "busy") return BUSY;
      if (claim.kind === "ready") {
        const record = await storedArtifact(
          dependencies.attachments,
          context,
          channelId,
          claim.attachmentId,
        ).catch(() => null);
        return record &&
          matchesRequest(
            record,
            args,
            artifactAttachmentMessageId(claim.exportId),
          )
          ? artifactResult(args.title, record)
          : BUSY;
      }

      let reservation: Awaited<ReturnType<AttachmentUploadService["reserve"]>>;
      try {
        const recovered = await recoverPublishedAttachment(
          dependencies,
          context,
          channelId,
          claim,
          args,
        );
        if (recovered) {
          if (
            !(await dependencies.exports.complete(
              claim.exportId,
              claim.leaseToken,
              recovered.id,
            ))
          ) {
            await dependencies.exports.fail(claim.exportId, claim.leaseToken);
            return BUSY;
          }
          return artifactResult(args.title, recovered);
        }

        const source = args.content as string;
        const bytes =
          args.mimeType === "application/pdf"
            ? await (dependencies.renderer as ArtifactRenderer).renderMarkdown({
                title: args.title,
                markdown: source,
              })
            : new TextEncoder().encode(source);
        reservation = await dependencies.uploads.reserve(
          context.actorId,
          channelId,
        );
        if (!reservation) throw new Error("Artifact reservation refused");
        const attachment = await dependencies.uploads.upload(
          context.actorId,
          channelId,
          "agent_generated",
          reservation,
          {
            messageId: claim.messageId,
            name: args.filename,
            mimeType: args.mimeType,
          },
          bytesStream(bytes),
        );
        if (!attachment) throw new Error("Artifact upload lease changed");
        if (
          !(await dependencies.exports.complete(
            claim.exportId,
            claim.leaseToken,
            attachment.id,
          ))
        ) {
          throw new Error("Artifact export lease expired");
        }
        return artifactResult(args.title, attachment);
      } catch {
        await dependencies.exports
          .fail(claim.exportId, claim.leaseToken)
          .catch(() => false);
        return UNAVAILABLE;
      }
    },
  });
}

export type ArtifactTools = ReturnType<typeof createArtifactTools>;
