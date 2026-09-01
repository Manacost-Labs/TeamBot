const REDEMPTION_PATH = "/internal/ai-credentials/redeem";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_MANAGED_TOKEN_CHARACTERS = 4_096;
const MAX_RUN_ASSERTION_CHARACTERS = 8_192;
const MAX_OPENROUTER_KEY_CHARACTERS = 4_096;
const MAX_CHATGPT_AUTH_DOCUMENT_CHARACTERS = 256 * 1_024;
const MAX_RESPONSE_BYTES = MAX_CHATGPT_AUTH_DOCUMENT_CHARACTERS + 1_024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PersonalProviderConnection =
  | Readonly<{ provider: "openrouter"; apiKey: string }>
  | Readonly<{ provider: "chatgpt"; authDocument: string }>;

export type PersonalProviderConnectionReference = Readonly<{
  lease: string;
  run: string;
}>;

export type PersonalProviderConnectionResolver = (
  reference: PersonalProviderConnectionReference,
  signal?: AbortSignal,
) => Promise<PersonalProviderConnection>;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** One outward failure that never carries lease, run assertion, endpoint or provider material. */
export class PersonalProviderConnectionUnavailableError extends Error {
  constructor() {
    super("Personal AI connection is unavailable.");
    this.name = "PersonalProviderConnectionUnavailableError";
  }
}

function invalidConfiguration(): never {
  throw new Error("Personal provider connection configuration is invalid.");
}

function redemptionUrl(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return invalidConfiguration();
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return invalidConfiguration();
  }
  return new URL(REDEMPTION_PATH, parsed.origin).toString();
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function providerConnection(value: unknown): PersonalProviderConnection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    source.provider === "openrouter" &&
    exactKeys(source, ["apiKey", "provider"]) &&
    typeof source.apiKey === "string" &&
    source.apiKey.length > 0 &&
    source.apiKey.length <= MAX_OPENROUTER_KEY_CHARACTERS &&
    source.apiKey.trim() === source.apiKey
  ) {
    return { provider: "openrouter", apiKey: source.apiKey };
  }
  if (
    source.provider === "chatgpt" &&
    exactKeys(source, ["authDocument", "provider"]) &&
    typeof source.authDocument === "string" &&
    source.authDocument.trim().length > 0 &&
    source.authDocument.length <= MAX_CHATGPT_AUTH_DOCUMENT_CHARACTERS
  ) {
    return { provider: "chatgpt", authDocument: source.authDocument };
  }
  return null;
}

function validReference(
  reference: PersonalProviderConnectionReference,
): boolean {
  return (
    UUID.test(reference.lease) &&
    typeof reference.run === "string" &&
    reference.run.length > 0 &&
    reference.run.length <= MAX_RUN_ASSERTION_CHARACTERS &&
    reference.run.trim() === reference.run
  );
}

function jsonMediaType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    throw new PersonalProviderConnectionUnavailableError();
  }
  if (!response.body) throw new PersonalProviderConnectionUnavailableError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PersonalProviderConnectionUnavailableError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (size === 0) throw new PersonalProviderConnectionUnavailableError();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PersonalProviderConnectionUnavailableError();
  }
}

/**
 * Build the only client allowed to resolve a run's personal provider.
 *
 * The destination and managed credential are captured from protected startup configuration. The
 * per-run call accepts only the server-minted opaque lease and signed run assertion. Provider
 * plaintext is returned as a discriminated in-memory value and is never copied into a thrown error.
 */
export function createPersonalProviderConnectionResolver(options: {
  serverUrl: string;
  managedAgentToken: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): PersonalProviderConnectionResolver {
  const endpoint = redemptionUrl(options.serverUrl);
  const managedAgentToken = options.managedAgentToken;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    managedAgentToken.length === 0 ||
    managedAgentToken.length > MAX_MANAGED_TOKEN_CHARACTERS ||
    managedAgentToken.trim() !== managedAgentToken ||
    /[\r\n]/.test(managedAgentToken) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return invalidConfiguration();
  }
  const fetch = options.fetch ?? globalThis.fetch;

  return async (reference, signal) => {
    if (!validReference(reference)) {
      throw new PersonalProviderConnectionUnavailableError();
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": managedAgentToken,
        },
        body: JSON.stringify({ lease: reference.lease, run: reference.run }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (
        !response.ok ||
        !jsonMediaType(response.headers.get("content-type"))
      ) {
        throw new PersonalProviderConnectionUnavailableError();
      }
      const text = await boundedResponseText(response);
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new PersonalProviderConnectionUnavailableError();
      }
      const connection = providerConnection(decoded);
      if (!connection) {
        throw new PersonalProviderConnectionUnavailableError();
      }
      return connection;
    } catch {
      throw new PersonalProviderConnectionUnavailableError();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}
