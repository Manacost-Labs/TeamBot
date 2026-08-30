/** Maximum attachment references carried from one AG-UI message into a model prompt. */
export const MAX_MESSAGE_ATTACHMENT_IDS = 10;

/** Deliberately neutral: models must use governed tools rather than infer attachment contents. */
export const ATTACHMENT_ACCESS_MARKER =
  "OpenBot attachments available through governed tools";

type MessageRole =
  | "assistant"
  | "developer"
  | "system"
  | "tool"
  | "user"
  | string;

const ATTACHMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reduce AG-UI content to the only prompt-safe fields the runtimes need.
 *
 * Binary payloads, URLs and metadata never cross this boundary. A user message carries only bounded
 * public attachment ids, which the model may pass to separately authorised conversation tools.
 */
export function projectMessageContent(
  content: unknown,
  role: MessageRole,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const text = content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("\n");

  if (role !== "user") return text;

  const attachmentIds: string[] = [];
  const seen = new Set<string>();
  for (const part of content) {
    if (attachmentIds.length >= MAX_MESSAGE_ATTACHMENT_IDS) break;
    if (typeof part !== "object" || part === null) continue;
    const candidate = part as { type?: unknown; id?: unknown };
    if (
      candidate.type !== "binary" ||
      typeof candidate.id !== "string" ||
      !ATTACHMENT_ID.test(candidate.id) ||
      seen.has(candidate.id)
    ) {
      continue;
    }
    seen.add(candidate.id);
    attachmentIds.push(candidate.id);
  }

  if (attachmentIds.length === 0) return text;
  const marker = `[${ATTACHMENT_ACCESS_MARKER}: ${attachmentIds.join(", ")}]`;
  return text ? `${text}\n\n${marker}` : marker;
}
