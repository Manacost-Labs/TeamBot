import {
  deleteAttachment,
  type UploadedAttachment,
  uploadAttachment,
} from "@/lib/attachments/api";
import { traceAttachmentUpload } from "@/lib/performance/workspace-timing";

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const ATTACHMENT_UPLOAD_CONCURRENCY = 3;
const ATTACHMENT_CLEANUP_DEADLINE_MS = 2_000;
export const ATTACHMENT_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.gif,.svg,.txt,.md,.json,.csv,.xml,.yaml,.yml,.pdf,.docx,.xlsx";

const ALLOWED_EXTENSIONS = new Set(
  ATTACHMENT_ACCEPT.split(",").map((extension) => extension.slice(1)),
);
const RASTER_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export type AttachmentDraftStatus = "queued" | "uploading" | "ready" | "failed";

export type AttachmentDraftItem = {
  localId: string;
  file: File;
  previewUrl: string | null;
  status: AttachmentDraftStatus;
  attachment: UploadedAttachment | null;
  uploadedChannelId: string | null;
  error: string | null;
};

export type AttachmentDraftAction =
  | { type: "replace"; items: readonly AttachmentDraftItem[] }
  | { type: "uploading"; localId: string }
  | {
      type: "ready";
      localId: string;
      attachment: UploadedAttachment;
      channelId: string;
    }
  | { type: "failed"; localId: string; error: string }
  | { type: "retry"; localId: string }
  | { type: "remove"; localId: string }
  | { type: "reset" };

/** Ephemeral upload handle. Files stay inside the mounted composer and never enter a message. */
export type AttachmentSubmission = {
  count: number;
  /** Acknowledge that the message owns these uploads; safe to call more than once. */
  commit(): void;
  upload(channelId: string): Promise<UploadedAttachment[]>;
};

export function attachmentExtension(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

export function isAllowedAttachment(file: File): boolean {
  const extension = attachmentExtension(file.name);
  return extension !== null && ALLOWED_EXTENSIONS.has(extension);
}

function hasRasterPreview(file: File): boolean {
  const extension = attachmentExtension(file.name);
  return extension !== null && RASTER_EXTENSIONS.has(extension);
}

export function addAttachmentFiles(
  current: readonly AttachmentDraftItem[],
  files: readonly File[],
  createPreviewUrl: (file: File) => string = URL.createObjectURL,
): { items: AttachmentDraftItem[]; rejected: string[] } {
  const items = [...current];
  const rejected: string[] = [];
  const fingerprints = new Set(
    items.map(
      ({ file }) =>
        `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`,
    ),
  );

  for (const file of files) {
    const fingerprint = `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`;
    if (fingerprints.has(fingerprint)) continue;
    if (
      items.length >= MAX_ATTACHMENTS_PER_MESSAGE ||
      !isAllowedAttachment(file)
    ) {
      rejected.push(file.name || "Файл без имени");
      continue;
    }

    fingerprints.add(fingerprint);
    items.push({
      localId: crypto.randomUUID(),
      file,
      previewUrl: hasRasterPreview(file) ? createPreviewUrl(file) : null,
      status: "queued",
      attachment: null,
      uploadedChannelId: null,
      error: null,
    });
  }

  return { items, rejected };
}

export function attachmentDraftReducer(
  state: readonly AttachmentDraftItem[],
  action: AttachmentDraftAction,
): AttachmentDraftItem[] {
  if (action.type === "replace") return [...action.items];
  if (action.type === "reset") return [];
  if (action.type === "remove") {
    return state.filter((item) => item.localId !== action.localId);
  }

  return state.map((item) => {
    if (item.localId !== action.localId) return item;
    switch (action.type) {
      case "uploading":
        return { ...item, status: "uploading", error: null };
      case "ready":
        return {
          ...item,
          status: "ready",
          attachment: action.attachment,
          uploadedChannelId: action.channelId,
          error: null,
        };
      case "failed":
        return {
          ...item,
          status: "failed",
          attachment: null,
          uploadedChannelId: null,
          error: action.error,
        };
      case "retry":
        return {
          ...item,
          status: "queued",
          attachment: null,
          uploadedChannelId: null,
          error: null,
        };
      default:
        return item;
    }
  });
}

function failedUploadMessage(count: number): string {
  if (count % 10 === 1 && count % 100 !== 11) {
    return `Не удалось загрузить ${count} файл.`;
  }
  if (
    count % 10 >= 2 &&
    count % 10 <= 4 &&
    (count % 100 < 12 || count % 100 > 14)
  ) {
    return `Не удалось загрузить ${count} файла.`;
  }
  return `Не удалось загрузить ${count} файлов.`;
}

/** Cleanup cannot hold a send forever; its rejection remains observed even after the deadline. */
async function deleteAttachmentBestEffort({
  channelId,
  attachmentId,
  deleteUploaded,
  lifetimeSignal,
}: {
  channelId: string;
  attachmentId: string;
  deleteUploaded: (
    channelId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  lifetimeSignal?: AbortSignal;
}): Promise<void> {
  const controller = new AbortController();
  let releaseDeadline = () => {};
  const deadline = new Promise<void>((resolve) => {
    releaseDeadline = resolve;
  });
  const abortCleanup = () => {
    controller.abort(lifetimeSignal?.reason);
    releaseDeadline();
  };
  if (lifetimeSignal?.aborted) abortCleanup();
  else lifetimeSignal?.addEventListener("abort", abortCleanup, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException("Attachment cleanup timed out.", "TimeoutError"),
    );
    releaseDeadline();
  }, ATTACHMENT_CLEANUP_DEADLINE_MS);
  let deletion: Promise<void>;
  try {
    deletion = deleteUploaded(channelId, attachmentId, controller.signal).catch(
      () => undefined,
    );
  } catch {
    deletion = Promise.resolve();
  }

  try {
    await Promise.race([deletion, deadline]);
  } finally {
    clearTimeout(timeout);
    lifetimeSignal?.removeEventListener("abort", abortCleanup);
  }
}

export async function uploadAttachmentDraft({
  channelId,
  items,
  dispatch,
  upload = uploadAttachment,
  deleteUploaded = deleteAttachment,
  signal,
  concurrency = ATTACHMENT_UPLOAD_CONCURRENCY,
}: {
  channelId: string;
  items: readonly AttachmentDraftItem[];
  dispatch: (action: AttachmentDraftAction) => void;
  upload?: (
    channelId: string,
    file: File,
    signal?: AbortSignal,
  ) => Promise<UploadedAttachment>;
  deleteUploaded?: (
    channelId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  signal?: AbortSignal;
  concurrency?: number;
}): Promise<UploadedAttachment[]> {
  signal?.throwIfAborted();
  const canReuse = (item: AttachmentDraftItem) =>
    item.status === "ready" &&
    item.attachment !== null &&
    item.uploadedChannelId === channelId;
  const uploaded: Array<UploadedAttachment | undefined> = items.map((item) =>
    canReuse(item) ? (item.attachment ?? undefined) : undefined,
  );
  const queue = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        item.status === "queued" ||
        (item.status === "ready" && !canReuse(item)),
    );
  let cursor = 0;
  let failures = 0;
  const createdThisAttempt: UploadedAttachment[] = [];

  const worker = async () => {
    while (cursor < queue.length) {
      if (signal?.aborted) return;
      const next = queue[cursor];
      cursor += 1;
      if (!next) return;
      const { item, index } = next;
      dispatch({ type: "uploading", localId: item.localId });
      try {
        if (
          item.attachment &&
          item.uploadedChannelId &&
          item.uploadedChannelId !== channelId
        ) {
          await deleteAttachmentBestEffort({
            channelId: item.uploadedChannelId,
            attachmentId: item.attachment.id,
            deleteUploaded,
            lifetimeSignal: signal,
          });
        }
        signal?.throwIfAborted();
        const attachment = await traceAttachmentUpload(() =>
          upload(channelId, item.file, signal),
        );
        createdThisAttempt.push(attachment);
        if (signal?.aborted) return;
        uploaded[index] = attachment;
        dispatch({
          type: "ready",
          localId: item.localId,
          attachment,
          channelId,
        });
      } catch (error) {
        if (signal?.aborted) return;
        failures += 1;
        dispatch({
          type: "failed",
          localId: item.localId,
          error:
            error instanceof Error
              ? error.message
              : "Не удалось загрузить файл.",
        });
      }
    }
  };

  const workerCount = Math.min(
    queue.length,
    Math.max(1, Math.floor(concurrency)),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (signal?.aborted) {
    const cleanupRefs = new Map<
      string,
      { channelId: string; attachmentId: string }
    >();
    for (const item of items) {
      if (!item.attachment || !item.uploadedChannelId) continue;
      const key = `${item.uploadedChannelId}\u0000${item.attachment.id}`;
      cleanupRefs.set(key, {
        channelId: item.uploadedChannelId,
        attachmentId: item.attachment.id,
      });
    }
    for (const attachment of createdThisAttempt) {
      const key = `${channelId}\u0000${attachment.id}`;
      cleanupRefs.set(key, { channelId, attachmentId: attachment.id });
    }
    for (const ref of cleanupRefs.values()) {
      void deleteAttachmentBestEffort({
        channelId: ref.channelId,
        attachmentId: ref.attachmentId,
        deleteUploaded,
      });
    }
    signal.throwIfAborted();
  }

  if (failures > 0) throw new Error(failedUploadMessage(failures));
  if (uploaded.some((attachment) => attachment === undefined)) {
    throw new Error("Не все вложения готовы к отправке.");
  }
  signal?.throwIfAborted();
  return uploaded as UploadedAttachment[];
}

export function releaseAttachmentPreviews(
  items: readonly AttachmentDraftItem[],
  revokePreviewUrl: (url: string) => void = URL.revokeObjectURL,
): void {
  for (const item of items) {
    if (item.previewUrl) revokePreviewUrl(item.previewUrl);
  }
}
