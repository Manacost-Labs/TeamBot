import type { PersonalAiSafeMetadata } from "./store";

const OPENROUTER_CURRENT_KEY_URL = "https://openrouter.ai/api/v1/key";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export type OpenRouterKeyValidationFailureCode =
  | "invalid_key"
  | "forbidden"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_refused"
  | "invalid_response";

export type OpenRouterKeyValidationResult =
  | Readonly<{ ok: true; metadata: PersonalAiSafeMetadata }>
  | Readonly<{ ok: false; code: OpenRouterKeyValidationFailureCode }>;

export type OpenRouterKeyValidator = Readonly<{
  validate: (
    key: string,
    options?: { signal?: AbortSignal },
  ) => Promise<OpenRouterKeyValidationResult>;
}>;

function validKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length < 1 || key.length > 4_096) {
    return false;
  }
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    // Visible ASCII exactly. Whitespace is not trimmed, Unicode is not normalized and no current
    // provider prefix is assumed, so validation cannot silently mutate what will later be stored.
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function boundedTimeout(value: number | undefined) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function requestSignal(timeoutMs: number, caller?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

function cancelBody(body: ReadableStream<Uint8Array> | null) {
  // Cancellation is best-effort and deliberately not awaited. A hostile or broken stream is allowed
  // to ignore cancellation, but not to keep key validation pending after its result is already known.
  try {
    void body?.cancel().catch(() => undefined);
  } catch {
    // A malformed injected transport can throw synchronously from cancel. It still cannot affect the
    // stable validation result or expose its exception to the caller.
  }
}

function failureForStatus(status: number): OpenRouterKeyValidationFailureCode {
  if (status === 401) return "invalid_key";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 408 || (status >= 500 && status <= 599)) {
    return "provider_unavailable";
  }
  return "provider_refused";
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  signal.throwIfAborted();
  const read = reader.read();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([read, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "invalid_response" | "provider_unavailable" };

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<BodyResult> {
  const contentType = response.headers.get("content-type");
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    cancelBody(response.body);
    return { ok: false, code: "invalid_response" };
  }

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = /^\d+$/.test(declared) ? Number(declared) : Number.NaN;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RESPONSE_BYTES) {
      cancelBody(response.body);
      return { ok: false, code: "invalid_response" };
    }
  }
  if (!response.body) return { ok: false, code: "invalid_response" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let code: "invalid_response" | "provider_unavailable" | undefined;
  try {
    for (;;) {
      const part = await readWithAbort(reader, signal);
      // Cancelling a pending reader can resolve that read as `done` before the abort rejection wins
      // the race. Re-checking the shared deadline prevents a timed-out empty body from being
      // misclassified as malformed provider JSON.
      signal.throwIfAborted();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        code = "invalid_response";
        break;
      }
      size += part.value.byteLength;
      if (!Number.isSafeInteger(size) || size > MAX_RESPONSE_BYTES) {
        code = "invalid_response";
        break;
      }
      chunks.push(part.value);
    }
  } catch {
    code = "provider_unavailable";
  } finally {
    void reader.cancel(signal.reason).catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A pending read keeps the lock until the underlying source observes cancellation.
    }
  }
  if (code) return { ok: false, code };

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: "invalid_response" };
  }
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableNonNegativeFinite(value: unknown): value is number | null {
  return value === null || nonNegativeFinite(value);
}

function projectMetadata(value: unknown): PersonalAiSafeMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;

  if (
    !nonNegativeFinite(fields.usage) ||
    !nullableNonNegativeFinite(fields.limit) ||
    !nullableNonNegativeFinite(fields.limit_remaining) ||
    typeof fields.is_free_tier !== "boolean"
  ) {
    return null;
  }

  return {
    usageUsd: fields.usage,
    limitUsd: fields.limit,
    limitRemainingUsd: fields.limit_remaining,
    isFreeTier: fields.is_free_tier,
  };
}

/**
 * Validate an OpenRouter key against the provider's current-key endpoint.
 *
 * The endpoint, method and headers are constants. The only caller-controlled request value is the
 * bearer key itself; redirects, retries, vendor error bodies and vendor metadata are all excluded.
 */
export function createOpenRouterKeyValidator(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): OpenRouterKeyValidator {
  const request = options.fetchImpl ?? fetch;
  const timeoutMs = boundedTimeout(options.timeoutMs);

  return Object.freeze({
    async validate(key, validateOptions = {}) {
      if (!validKey(key)) return { ok: false, code: "invalid_key" };

      const signal = requestSignal(timeoutMs, validateOptions.signal);
      let response: Response;
      try {
        response = await request(OPENROUTER_CURRENT_KEY_URL, {
          method: "GET",
          credentials: "omit",
          redirect: "manual",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${key}`,
          },
          signal,
        });
      } catch {
        return { ok: false, code: "provider_unavailable" };
      }

      // A controlled transport may ignore the AbortSignal and resolve after the deadline. The
      // timeout still owns the whole operation, so a late HTTP status must not override it.
      if (signal.aborted) {
        cancelBody(response.body);
        return { ok: false, code: "provider_unavailable" };
      }

      // Exactly 200 is the documented successful response. This branch deliberately reads neither
      // Location nor any other response header and never consumes a vendor error body.
      if (response.status !== 200) {
        cancelBody(response.body);
        return { ok: false, code: failureForStatus(response.status) };
      }

      let body: BodyResult;
      try {
        body = await boundedJson(response, signal);
      } catch {
        // A real Fetch Response has well-formed headers and a readable body. Injected transports and
        // future runtimes are still treated as untrusted at this boundary, without echoing errors.
        cancelBody(response.body);
        return { ok: false, code: "invalid_response" };
      }
      if (!body.ok) return body;
      const metadata = projectMetadata(body.value);
      return metadata
        ? { ok: true, metadata }
        : { ok: false, code: "invalid_response" };
    },
  });
}
