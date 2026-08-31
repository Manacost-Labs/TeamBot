import type {
  ImageInputContent,
  RunAgentInput,
  UserMessage,
} from "@ag-ui/client";
import {
  attachmentIdsFromMessageContent,
  projectMessageContent,
} from "../../../shared/message-content";
import type {
  ConversationAttachmentContentSource,
  ConversationAttachmentModelStore,
  TrustedAttachmentToolContext,
} from "./tool-store";

const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 10_000;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type AttachmentModelImageLimits = Readonly<{
  maxImages?: number;
  maxBytesPerImage?: number;
  maxTotalBytes?: number;
  readTimeoutMs?: number;
}>;

type EffectiveLimits = Readonly<{
  maxImages: number;
  maxBytesPerImage: number;
  maxTotalBytes: number;
  readTimeoutMs: number;
}>;

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function effectiveLimits(limits: AttachmentModelImageLimits): EffectiveLimits {
  return {
    maxImages: positiveLimit(limits.maxImages, DEFAULT_MAX_IMAGES),
    maxBytesPerImage: positiveLimit(
      limits.maxBytesPerImage,
      DEFAULT_MAX_BYTES_PER_IMAGE,
    ),
    maxTotalBytes: positiveLimit(limits.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
    readTimeoutMs: positiveLimit(limits.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS),
  };
}

/** Strip every client-supplied binary, URL and filename before a message reaches any model. */
export function projectRunInputForModel(input: RunAgentInput): RunAgentInput {
  return {
    ...input,
    messages: input.messages.map(
      (message) =>
        ({
          ...message,
          content: projectMessageContent(message.content, message.role),
        }) as typeof message,
    ),
  };
}

function deadline(timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Attachment image read timed out")),
    timeoutMs,
  );
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function waitWithSignal<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readBounded(
  source: ConversationAttachmentContentSource,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const opening = source.openStream(signal);
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await waitWithSignal(opening, signal);
    } catch (error) {
      if (signal.aborted) {
        void opening
          .then((lateStream) => lateStream.cancel(signal.reason))
          .catch(() => undefined);
      }
      throw error;
    }
    reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await readChunk(reader, signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) return null;
      size += part.value.byteLength;
      if (!Number.isSafeInteger(size) || size > maximumBytes) return null;
      chunks.push(part.value);
    }
    if (size !== source.attachment.size || size === 0) return null;
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch {
    return null;
  } finally {
    if (reader) {
      await reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // A timed-out read releases after its cancellation settles.
      }
    }
  }
}

function imagePart(mimeType: string, content: Uint8Array): ImageInputContent {
  return {
    type: "image",
    source: {
      type: "data",
      value: Buffer.from(content).toString("base64"),
      mimeType,
    },
  };
}

/**
 * Build a per-person, per-run image preparer for built-in agents.
 *
 * Only the latest user turn is enriched. IDs come from that original turn, while MIME, size and
 * bytes come only from the server-authorized store. Every returned message is a fresh object, so
 * the runtime can persist the original opaque references without persisting base64.
 */
export function createAttachmentModelInputPreparer(
  store: ConversationAttachmentModelStore,
  actorId: string,
  configuredLimits: AttachmentModelImageLimits = {},
): (botId: string, input: RunAgentInput) => Promise<RunAgentInput> {
  const limits = effectiveLimits(configuredLimits);
  return async (botId, input) => {
    const safeInput = projectRunInputForModel(input);
    let latestUserIndex = -1;
    for (let index = input.messages.length - 1; index >= 0; index -= 1) {
      if (input.messages[index]?.role === "user") {
        latestUserIndex = index;
        break;
      }
    }
    if (latestUserIndex < 0) return safeInput;

    const original = input.messages[latestUserIndex];
    const ids = attachmentIdsFromMessageContent(original?.content);
    if (ids.length === 0) return safeInput;

    const context: TrustedAttachmentToolContext = {
      actorId,
      botId,
      threadId: input.threadId,
    };
    const images: ImageInputContent[] = [];
    let totalBytes = 0;
    const timer = deadline(limits.readTimeoutMs);
    try {
      for (const id of ids) {
        if (images.length >= limits.maxImages || timer.signal.aborted) break;
        const source = await waitWithSignal(
          store.contentSource(context, id, timer.signal),
          timer.signal,
        ).catch(() => null);
        if (
          !source ||
          !ALLOWED_IMAGE_MIME_TYPES.has(source.attachment.mimeType) ||
          source.attachment.size < 1 ||
          source.attachment.size > limits.maxBytesPerImage ||
          totalBytes + source.attachment.size > limits.maxTotalBytes
        ) {
          continue;
        }
        const content = await readBounded(
          source,
          Math.min(limits.maxBytesPerImage, limits.maxTotalBytes - totalBytes),
          timer.signal,
        );
        if (!content) continue;
        totalBytes += content.byteLength;
        images.push(imagePart(source.attachment.mimeType, content));
      }
    } finally {
      timer.dispose();
    }
    if (images.length === 0) return safeInput;

    const safeMessage = safeInput.messages[latestUserIndex] as UserMessage;
    const text =
      typeof safeMessage.content === "string" ? safeMessage.content : "";
    const enriched: UserMessage = {
      ...safeMessage,
      content: [...(text ? [{ type: "text" as const, text }] : []), ...images],
    };
    return {
      ...safeInput,
      messages: safeInput.messages.map((message, index) =>
        index === latestUserIndex ? enriched : message,
      ),
    };
  };
}
