import { AttachmentQueryError } from "./store";
import type {
  ConversationAttachmentMetadata,
  ConversationAttachmentPage,
  ConversationAttachmentToolStore,
  TrustedAttachmentToolContext,
} from "./tool-store";

const DEFAULT_TEXT_PAGE_CODE_POINTS = 12_000;
const MAX_TEXT_PAGE_CODE_POINTS = 24_000;
const MAX_TOTAL_TEXT_CODE_POINTS = 1_000_000;
const DEFAULT_TEXT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENT_TEXT_READS = 4;
const DEFAULT_QUEUED_TEXT_READS = 32;
const MAX_CURSOR_CODE_UNITS = 4_096;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

export type AttachmentToolErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "UNSUPPORTED_MEDIA_TYPE";

export type AttachmentToolError = Readonly<{
  code: AttachmentToolErrorCode;
  message: string;
}>;

export type AttachmentToolResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; error: AttachmentToolError }>;

export type ReadAttachmentTextPage = Readonly<{
  attachment: ConversationAttachmentMetadata;
  text: string;
  cursor: number;
  nextCursor: number | null;
  truncated: boolean;
}>;

export type ConversationAttachmentTools = Readonly<{
  listConversationAttachments(
    context: TrustedAttachmentToolContext,
    args?: unknown,
  ): Promise<AttachmentToolResult<ConversationAttachmentPage>>;
  readAttachmentMetadata(
    context: TrustedAttachmentToolContext,
    args: unknown,
  ): Promise<AttachmentToolResult<ConversationAttachmentMetadata>>;
  readAttachmentText(
    context: TrustedAttachmentToolContext,
    args: unknown,
  ): Promise<AttachmentToolResult<ReadAttachmentTextPage>>;
}>;

export type ConversationAttachmentToolLimits = Readonly<{
  textReadTimeoutMs?: number;
  maxConcurrentTextReads?: number;
  maxQueuedTextReads?: number;
  maxTotalTextCodePoints?: number;
}>;

type ListArgs = { cursor?: string; limit?: number };
type AttachmentIdArgs = { attachmentId: string };
type ReadTextArgs = AttachmentIdArgs & { cursor?: number; maxChars?: number };

class AttachmentToolUnavailableError extends Error {}

class TextReadLimiter {
  private active = 0;
  private readonly queue: Array<{
    signal: AbortSignal;
    start: (release: () => void) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(
    private readonly maximum: number,
    private readonly maxQueued: number,
  ) {}

  async run<Value>(
    signal: AbortSignal,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const release = await this.acquire(signal);
    const ownedOperation = Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          release();
          return value;
        },
        (error) => {
          release();
          throw error;
        },
      );
    return abortable(ownedOperation, signal);
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new AttachmentToolUnavailableError());
    }

    return new Promise<() => void>((resolve, reject) => {
      const queued = {
        signal,
        reject,
        start: resolve,
      };
      const abort = () => {
        const index = this.queue.indexOf(queued);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      queued.start = (release) => {
        signal.removeEventListener("abort", abort);
        resolve(release);
      };
      this.queue.push(queued);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      while (this.queue.length > 0) {
        const queued = this.queue.shift();
        if (!queued || queued.signal.aborted) continue;
        this.active += 1;
        queued.start(this.releaseOnce());
        break;
      }
    };
  }
}

const INVALID_ARGUMENT = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "INVALID_ARGUMENT",
    message: "Invalid tool arguments.",
  }),
}) satisfies AttachmentToolResult<never>;

const NOT_FOUND = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "NOT_FOUND",
    message: "Conversation attachment was not found.",
  }),
}) satisfies AttachmentToolResult<never>;

const UNAVAILABLE = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "UNAVAILABLE",
    message: "Attachment text is temporarily unavailable.",
  }),
}) satisfies AttachmentToolResult<never>;

const INVENTORY_UNAVAILABLE = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "UNAVAILABLE",
    message: "Conversation attachments are temporarily unavailable.",
  }),
}) satisfies AttachmentToolResult<never>;

const UNSUPPORTED_MEDIA_TYPE = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "This attachment does not have readable text.",
  }),
}) satisfies AttachmentToolResult<never>;

function success<Value>(value: Value): AttachmentToolResult<Value> {
  return { ok: true, value };
}

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

function listArgs(value: unknown): ListArgs | null {
  if (value === undefined) return {};
  if (!plainObject(value) || !hasOnlyKeys(value, new Set(["cursor", "limit"])))
    return null;
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== "string" ||
      value.cursor.length === 0 ||
      value.cursor.length > MAX_CURSOR_CODE_UNITS)
  )
    return null;
  if (
    value.limit !== undefined &&
    (typeof value.limit !== "number" ||
      !Number.isSafeInteger(value.limit) ||
      value.limit < 1)
  )
    return null;
  return {
    cursor: value.cursor as string | undefined,
    limit: value.limit as number | undefined,
  };
}

function attachmentIdArgs(value: unknown): AttachmentIdArgs | null {
  if (
    !plainObject(value) ||
    !hasOnlyKeys(value, new Set(["attachmentId"])) ||
    typeof value.attachmentId !== "string"
  )
    return null;
  return { attachmentId: value.attachmentId };
}

function readTextArgs(
  value: unknown,
  maxTotalTextCodePoints: number,
): ReadTextArgs | null {
  if (
    !plainObject(value) ||
    !hasOnlyKeys(value, new Set(["attachmentId", "cursor", "maxChars"])) ||
    typeof value.attachmentId !== "string"
  )
    return null;
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== "number" ||
      !Number.isSafeInteger(value.cursor) ||
      value.cursor < 0 ||
      value.cursor > maxTotalTextCodePoints)
  )
    return null;
  if (
    value.maxChars !== undefined &&
    (typeof value.maxChars !== "number" ||
      !Number.isSafeInteger(value.maxChars) ||
      value.maxChars < 1)
  )
    return null;
  return {
    attachmentId: value.attachmentId,
    cursor: value.cursor as number | undefined,
    maxChars: value.maxChars as number | undefined,
  };
}

function boundedPositiveLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1)
    return fallback;
  return Math.min(value, maximum);
}

function boundedNonNegativeLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    return fallback;
  return Math.min(value, maximum);
}

function deadline(timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new AttachmentToolUnavailableError()),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function abortable<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<Value>((resolve, reject) => {
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

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal.aborted) throw signal.reason;
  const read = reader.read();
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(signal.reason).then(
        () => reject(signal.reason),
        () => reject(signal.reason),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void read.then(
      () => signal.removeEventListener("abort", onAbort),
      () => signal.removeEventListener("abort", onAbort),
    );
  });
  return Promise.race([read, abort]);
}

async function extractTextPage(options: {
  stream: ReadableStream<Uint8Array>;
  cursor: number;
  maxChars: number;
  maxTotalTextCodePoints: number;
  signal: AbortSignal;
}): Promise<{
  text: string;
  nextCursor: number | null;
  truncated: boolean;
}> {
  const reader = options.stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const page: string[] = [];
  const pageEnd = Math.min(
    options.maxTotalTextCodePoints,
    options.cursor + options.maxChars,
  );
  let codePoints = 0;
  let truncated = false;
  let completed = false;

  const consume = (fragment: string): boolean => {
    for (const character of fragment) {
      if (codePoints >= options.cursor && codePoints < pageEnd) {
        page.push(character);
      }
      codePoints += 1;
      if (codePoints > pageEnd) {
        truncated = true;
        return false;
      }
    }
    return true;
  };

  try {
    while (true) {
      const next = await readWithAbort(reader, options.signal);
      if (next.done) {
        completed = true;
        consume(decoder.decode());
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new TypeError("Attachment text stream is invalid");
      }
      if (!consume(decoder.decode(next.value, { stream: true }))) break;
    }
  } finally {
    if (!completed) {
      await reader.cancel(options.signal.reason).catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // Cancellation owns a pending read and releases it when the source settles.
    }
  }

  const extractedEnd = options.cursor + page.length;
  return {
    text: page.join(""),
    nextCursor:
      truncated && extractedEnd < options.maxTotalTextCodePoints
        ? extractedEnd
        : null,
    truncated,
  };
}

/**
 * Stable, content-safe methods ready to be wrapped as a first-party builtin
 * plugin. Trusted run context is a separate parameter from model-controlled
 * arguments, so a tool call cannot ask for another channel or user.
 */
export function createConversationAttachmentTools(
  store: ConversationAttachmentToolStore,
  requestedLimits: ConversationAttachmentToolLimits = {},
): ConversationAttachmentTools {
  const timeoutMs = boundedPositiveLimit(
    requestedLimits.textReadTimeoutMs,
    DEFAULT_TEXT_READ_TIMEOUT_MS,
    DEFAULT_TEXT_READ_TIMEOUT_MS,
  );
  const maximumConcurrent = boundedPositiveLimit(
    requestedLimits.maxConcurrentTextReads,
    DEFAULT_CONCURRENT_TEXT_READS,
    DEFAULT_CONCURRENT_TEXT_READS,
  );
  const maximumQueued = boundedNonNegativeLimit(
    requestedLimits.maxQueuedTextReads,
    DEFAULT_QUEUED_TEXT_READS,
    DEFAULT_QUEUED_TEXT_READS,
  );
  const maxTotalTextCodePoints = boundedPositiveLimit(
    requestedLimits.maxTotalTextCodePoints,
    MAX_TOTAL_TEXT_CODE_POINTS,
    MAX_TOTAL_TEXT_CODE_POINTS,
  );
  const limiter = new TextReadLimiter(maximumConcurrent, maximumQueued);

  return Object.freeze({
    async listConversationAttachments(context, rawArgs) {
      const args = listArgs(rawArgs);
      if (!args) return INVALID_ARGUMENT;
      try {
        const page = await store.list(context, {
          cursor: args.cursor,
          limit:
            args.limit === undefined ? undefined : Math.min(50, args.limit),
        });
        return page ? success(page) : NOT_FOUND;
      } catch (error) {
        return error instanceof AttachmentQueryError
          ? INVALID_ARGUMENT
          : INVENTORY_UNAVAILABLE;
      }
    },

    async readAttachmentMetadata(context, rawArgs) {
      const args = attachmentIdArgs(rawArgs);
      if (!args) return INVALID_ARGUMENT;
      if (!UUID.test(args.attachmentId)) return NOT_FOUND;
      try {
        const attachment = await store.metadata(context, args.attachmentId);
        return attachment ? success(attachment) : NOT_FOUND;
      } catch {
        return INVENTORY_UNAVAILABLE;
      }
    },

    async readAttachmentText(context, rawArgs) {
      const args = readTextArgs(rawArgs, maxTotalTextCodePoints);
      if (!args) return INVALID_ARGUMENT;
      if (!UUID.test(args.attachmentId)) return NOT_FOUND;
      const cursor = args.cursor ?? 0;
      const maxChars = Math.min(
        MAX_TEXT_PAGE_CODE_POINTS,
        args.maxChars ?? DEFAULT_TEXT_PAGE_CODE_POINTS,
      );
      const scope = deadline(timeoutMs);
      try {
        return await limiter.run(scope.signal, async () => {
          const source = await store.textSource(
            context,
            args.attachmentId,
            scope.signal,
          );
          scope.signal.throwIfAborted();
          if (!source) return NOT_FOUND;
          if (!TEXT_MIME_TYPES.has(source.attachment.mimeType)) {
            return UNSUPPORTED_MEDIA_TYPE;
          }
          const stream = await source.openStream(scope.signal);
          if (scope.signal.aborted) {
            await stream.cancel(scope.signal.reason).catch(() => undefined);
            throw scope.signal.reason;
          }
          const page = await extractTextPage({
            stream,
            cursor,
            maxChars,
            maxTotalTextCodePoints,
            signal: scope.signal,
          });
          return success({
            attachment: source.attachment,
            text: page.text,
            cursor,
            nextCursor: page.nextCursor,
            truncated: page.truncated,
          });
        });
      } catch {
        return UNAVAILABLE;
      } finally {
        scope.dispose();
      }
    },
  });
}
