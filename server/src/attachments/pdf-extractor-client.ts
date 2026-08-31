const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CODE_POINTS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const PDF_SIGNATURE = new TextEncoder().encode("%PDF-");

export class PdfExtractorError extends Error {
  override readonly name = "PdfExtractorError";
}

export type PdfExtractedText = Readonly<{
  text: string;
  truncated: boolean;
}>;

export type PdfExtractor = Readonly<{
  extractText(input: {
    stream: ReadableStream<Uint8Array>;
    size: number;
    signal?: AbortSignal;
  }): Promise<PdfExtractedText>;
}>;

function extractEndpoint(baseUrl: string): URL {
  const parsed = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("PDF extractor URL must be a plain HTTP(S) address");
  }
  const basePath = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  parsed.pathname = `${basePath}extract`.replaceAll(/\/{2,}/g, "/");
  return parsed;
}

function deadline(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  return outer
    ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal.aborted) throw signal.reason;
  const read = reader.read();
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void read.then(
      () => signal.removeEventListener("abort", abort),
      () => signal.removeEventListener("abort", abort),
    );
  });
  return Promise.race([read, aborted]);
}

async function boundedBytes(options: {
  stream: ReadableStream<Uint8Array>;
  size: number;
  signal: AbortSignal;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isSafeInteger(options.size) ||
    options.size < PDF_SIGNATURE.length ||
    options.size > MAX_INPUT_BYTES
  ) {
    await options.stream.cancel().catch(() => undefined);
    throw new PdfExtractorError("PDF input size is invalid");
  }
  const reader = options.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      options.signal.throwIfAborted();
      const part = await readWithAbort(reader, options.signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new PdfExtractorError("PDF input is invalid");
      }
      size += part.value.byteLength;
      if (size > MAX_INPUT_BYTES || size > options.size) {
        throw new PdfExtractorError("PDF input exceeded its limit");
      }
      chunks.push(part.value);
    }
  } finally {
    if (options.signal.aborted) {
      void reader.cancel(options.signal.reason).catch(() => undefined);
    } else {
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // A pending read owns the lock until its source observes cancellation.
    }
  }
  if (size !== options.size) {
    throw new PdfExtractorError("PDF input size changed");
  }
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!PDF_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new PdfExtractorError("PDF signature is invalid");
  }
  return bytes;
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 2 || size > MAX_OUTPUT_BYTES) {
      throw new PdfExtractorError("PDF extractor output size is invalid");
    }
  }
  if (!response.body)
    throw new PdfExtractorError("PDF extractor returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await readWithAbort(reader, signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_OUTPUT_BYTES) {
        throw new PdfExtractorError("PDF extractor output exceeded its limit");
      }
      chunks.push(part.value);
    }
  } finally {
    if (signal.aborted) {
      void reader.cancel(signal.reason).catch(() => undefined);
    } else {
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // A pending read owns the lock until its source observes cancellation.
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PdfExtractorError("PDF extractor output is invalid");
  }
}

function validResult(value: unknown): value is PdfExtractedText {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["text", "truncated"].includes(key)) ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !("truncated" in value) ||
    typeof value.truncated !== "boolean"
  ) {
    return false;
  }
  let codePoints = 0;
  for (const _character of value.text) {
    codePoints += 1;
    if (codePoints > MAX_TEXT_CODE_POINTS) return false;
  }
  return true;
}

/** Internal byte-only client. It sends no attachment, tenant or actor metadata. */
export function createPdfExtractor(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): PdfExtractor {
  const endpoint = extractEndpoint(options.baseUrl);
  const request = options.fetch ?? fetch;
  const timeoutMs =
    options.timeoutMs !== undefined &&
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.min(options.timeoutMs, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  return Object.freeze({
    async extractText(input) {
      const signal = deadline(timeoutMs, input.signal);
      let response: Response;
      try {
        const pdf = await boundedBytes({ ...input, signal });
        response = await request(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/pdf",
          },
          body: pdf.buffer,
          signal,
        });
      } catch {
        throw new PdfExtractorError(
          "PDF extraction is temporarily unavailable",
        );
      }
      if (
        !response.ok ||
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new PdfExtractorError(
          "PDF extraction is temporarily unavailable",
        );
      }
      let result: unknown;
      try {
        result = await boundedJson(response, signal);
      } catch {
        throw new PdfExtractorError(
          "PDF extraction is temporarily unavailable",
        );
      }
      if (!validResult(result)) {
        throw new PdfExtractorError("PDF extractor returned invalid text");
      }
      return result;
    },
  });
}
