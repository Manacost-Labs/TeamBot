export type UploadedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
};

type AttachmentResponse = {
  attachment?: {
    id?: unknown;
    name?: unknown;
    filename?: unknown;
    mimeType?: unknown;
    size?: unknown;
  };
  error?: unknown;
};

function endpoint(channelId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/attachments`;
}

function attachmentEndpoint(channelId: string, attachmentId: string): string {
  return `${endpoint(channelId)}/${encodeURIComponent(attachmentId)}`;
}

/** Upload one file in one multipart request. Browser fetch owns the multipart boundary. */
export async function uploadAttachment(
  channelId: string,
  file: File,
  signal?: AbortSignal,
): Promise<UploadedAttachment> {
  signal?.throwIfAborted();
  const body = new FormData();
  body.append("file", file, file.name);
  const response = await fetch(endpoint(channelId), {
    method: "POST",
    credentials: "include",
    body,
    signal,
  });
  const payload = (await response
    .json()
    .catch(() => ({}))) as AttachmentResponse;

  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Не удалось загрузить файл.",
    );
  }

  const attachment = payload.attachment;
  const filename = attachment?.filename ?? attachment?.name;
  if (
    typeof attachment?.id !== "string" ||
    attachment.id.length === 0 ||
    typeof filename !== "string" ||
    filename.length === 0 ||
    typeof attachment.mimeType !== "string" ||
    attachment.mimeType.length === 0 ||
    typeof attachment.size !== "number" ||
    !Number.isFinite(attachment.size) ||
    attachment.size < 0
  ) {
    throw new Error("Некорректный ответ сервера при загрузке файла.");
  }

  return {
    id: attachment.id,
    filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

/** Authenticated download URL derived from public IDs; no storage path reaches the browser. */
export function attachmentDownloadUrl(
  channelId: string,
  attachmentId: string,
): string {
  return `${attachmentEndpoint(channelId, attachmentId)}/download`;
}

/** Remove an upload that the person took back before its message was sent. */
export async function deleteAttachment(
  channelId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(attachmentEndpoint(channelId, attachmentId), {
    method: "DELETE",
    credentials: "include",
    signal,
  });
  if (response.ok || response.status === 404) return;
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  throw new Error(
    typeof payload.error === "string"
      ? payload.error
      : "Не удалось удалить файл.",
  );
}
