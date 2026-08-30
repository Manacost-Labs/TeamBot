import type { InputContent } from "@ag-ui/core";
import type { UploadedAttachment } from "./api";

export type AttachmentMessageReference = {
  type: "binary";
  id: string;
  mimeType: string;
  filename: string;
};

export type AttachmentDescriptor = Pick<
  UploadedAttachment,
  "id" | "filename" | "mimeType"
>;

export function toAttachmentMessageReference(
  attachment: AttachmentDescriptor,
): AttachmentMessageReference {
  return {
    type: "binary",
    id: attachment.id,
    mimeType: attachment.mimeType,
    filename: attachment.filename,
  };
}

export function buildAttachmentMessageContent(
  text: string,
  attachments: readonly AttachmentDescriptor[],
): string | InputContent[] {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;
  return [
    ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
    ...attachments.map(toAttachmentMessageReference),
  ];
}

export function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export function attachmentRefsFromContent(
  content: unknown,
): AttachmentMessageReference[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const candidate = part as {
      type?: unknown;
      id?: unknown;
      mimeType?: unknown;
      filename?: unknown;
    };
    if (
      candidate.type !== "binary" ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      typeof candidate.mimeType !== "string" ||
      candidate.mimeType.length === 0 ||
      typeof candidate.filename !== "string" ||
      candidate.filename.length === 0
    ) {
      return [];
    }
    return [
      {
        type: "binary" as const,
        id: candidate.id,
        mimeType: candidate.mimeType,
        filename: candidate.filename,
      },
    ];
  });
}
