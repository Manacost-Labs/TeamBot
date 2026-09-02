import {
  ARTIFACT_MIME_TYPES,
  ARTIFACT_RESULT_SCHEMA,
  type ArtifactMimeType,
  artifactFilenameMatchesMimeType,
  parseArtifactResult,
} from "./contract";

export type ArtifactMetadata = Readonly<{
  id: string;
  filename: string;
  mimeType: ArtifactMimeType;
  size: number;
  messageId: string;
  source: "agent_generated";
}>;

type AttachmentResponse = {
  attachment?: {
    id?: unknown;
    name?: unknown;
    filename?: unknown;
    mimeType?: unknown;
    size?: unknown;
    messageId?: unknown;
    source?: unknown;
  };
  error?: unknown;
};

type AttachmentListResponse = {
  attachments?: unknown;
  error?: unknown;
};

const ARTIFACT_MIME_TYPE_SET = new Set<string>(ARTIFACT_MIME_TYPES);

function attachmentEndpoint(channelId: string, attachmentId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function artifactCollectionEndpoint(channelId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/attachments`;
}

const ARTIFACT_INDEX_LIMIT = 50;

function artifactFromList(value: unknown): ArtifactMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const filename = record.name ?? record.filename;
  const mimeType = record.mimeType;
  const size = record.size;
  const messageId = record.messageId;
  if (
    typeof id !== "string" ||
    typeof filename !== "string" ||
    typeof mimeType !== "string" ||
    typeof size !== "number" ||
    typeof messageId !== "string" ||
    record.source !== "agent_generated" ||
    !messageId.startsWith("artifact:")
  ) {
    return null;
  }
  const parsed = parseArtifactResult({
    schema: ARTIFACT_RESULT_SCHEMA,
    artifact: {
      attachmentId: id,
      filename,
      mimeType,
      size,
      title: filename,
    },
  });
  if (!parsed) return null;
  return {
    id: parsed.artifact.attachmentId,
    filename: parsed.artifact.filename,
    mimeType: parsed.artifact.mimeType,
    size: parsed.artifact.size,
    messageId,
    source: "agent_generated",
  };
}

/**
 * Read the recent generated files for a channel.
 *
 * Intelligence history can retain the attachment while losing the AG-UI tool-result envelope. The
 * index is only a recovery hint; `ArtifactCard` still fetches each item through the authenticated
 * metadata endpoint before showing a download or preview.
 */
export async function listChannelArtifacts(
  channelId: string,
  signal?: AbortSignal,
): Promise<readonly ArtifactMetadata[]> {
  signal?.throwIfAborted();
  const response = await fetch(
    `${artifactCollectionEndpoint(channelId)}?limit=${ARTIFACT_INDEX_LIMIT}`,
    { credentials: "include", signal },
  );
  const payload = (await response
    .json()
    .catch(() => ({}))) as AttachmentListResponse;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Не удалось получить файлы переписки.",
    );
  }
  if (!Array.isArray(payload.attachments)) return [];
  return payload.attachments.flatMap((value) => {
    const artifact = artifactFromList(value);
    return artifact ? [artifact] : [];
  });
}

/** Read authoritative public metadata through the same session and channel boundary as downloads. */
export async function readArtifactMetadata(
  channelId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<ArtifactMetadata> {
  const response = await fetch(attachmentEndpoint(channelId, attachmentId), {
    credentials: "include",
    signal,
  });
  const payload = (await response
    .json()
    .catch(() => ({}))) as AttachmentResponse;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Не удалось получить файл.",
    );
  }

  const attachment = payload.attachment;
  const filename = attachment?.filename ?? attachment?.name;
  if (
    attachment?.id !== attachmentId ||
    typeof filename !== "string" ||
    filename.length === 0 ||
    typeof attachment.mimeType !== "string" ||
    !ARTIFACT_MIME_TYPE_SET.has(attachment.mimeType) ||
    !artifactFilenameMatchesMimeType(
      filename,
      attachment.mimeType as ArtifactMimeType,
    ) ||
    typeof attachment.size !== "number" ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size <= 0 ||
    typeof attachment.messageId !== "string" ||
    !attachment.messageId.startsWith("artifact:") ||
    attachment.source !== "agent_generated"
  ) {
    throw new Error("Сервер вернул некорректные данные файла.");
  }

  return {
    id: attachment.id,
    filename,
    mimeType: attachment.mimeType as ArtifactMimeType,
    size: attachment.size,
    messageId: attachment.messageId,
    source: attachment.source,
  };
}

export function artifactDownloadUrl(
  channelId: string,
  attachmentId: string,
): string {
  return `${attachmentEndpoint(channelId, attachmentId)}/download`;
}

export function artifactPreviewUrl(
  channelId: string,
  attachmentId: string,
): string {
  return `${attachmentEndpoint(channelId, attachmentId)}/preview`;
}

/** Text/source previews are server-bounded; the client applies a second display-only cap. */
export async function readArtifactTextPreview(
  channelId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(artifactPreviewUrl(channelId, attachmentId), {
    credentials: "include",
    headers: { accept: "text/plain, text/markdown;q=0.9" },
    signal,
  });
  if (!response.ok) throw new Error("Не удалось открыть предпросмотр.");
  return (await response.text()).slice(0, 100_000);
}
