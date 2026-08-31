import {
  artifactFilenameMatchesMimeType,
  ARTIFACT_MIME_TYPES,
  type ArtifactMimeType,
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

const ARTIFACT_MIME_TYPE_SET = new Set<string>(ARTIFACT_MIME_TYPES);

function attachmentEndpoint(channelId: string, attachmentId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(attachmentId)}`;
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
