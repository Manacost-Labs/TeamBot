const DEFAULT_TIMEOUT_MS = 35_000;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const PDF_SIGNATURE = new TextEncoder().encode("%PDF-");

export class ArtifactRendererError extends Error {
  override readonly name = "ArtifactRendererError";

  constructor(
    readonly code: "UNAVAILABLE" | "INVALID_OUTPUT",
    message: string,
  ) {
    super(message);
  }
}

export type ArtifactRenderer = Readonly<{
  renderMarkdown(input: {
    title: string;
    markdown: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
}>;

function renderEndpoint(baseUrl: string): URL {
  const parsed = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Artifact renderer URL must be a plain HTTP(S) address");
  }
  const basePath = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  parsed.pathname = `${basePath}render`.replaceAll(/\/{2,}/g, "/");
  return parsed;
}

function deadline(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  return outer
    ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

async function boundedPdf(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (
      !Number.isSafeInteger(size) ||
      size < PDF_SIGNATURE.length ||
      size > MAX_PDF_BYTES
    ) {
      throw new ArtifactRendererError(
        "INVALID_OUTPUT",
        "Artifact renderer returned an invalid PDF size",
      );
    }
  }
  if (!response.body) {
    throw new ArtifactRendererError(
      "INVALID_OUTPUT",
      "Artifact renderer returned no PDF body",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new ArtifactRendererError(
          "INVALID_OUTPUT",
          "Artifact renderer returned invalid bytes",
        );
      }
      size += part.value.byteLength;
      if (!Number.isSafeInteger(size) || size > MAX_PDF_BYTES) {
        throw new ArtifactRendererError(
          "INVALID_OUTPUT",
          "Artifact renderer PDF exceeded the byte limit",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const pdf = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (
    pdf.byteLength < PDF_SIGNATURE.length ||
    !PDF_SIGNATURE.every((byte, index) => pdf[index] === byte)
  ) {
    throw new ArtifactRendererError(
      "INVALID_OUTPUT",
      "Artifact renderer returned a non-PDF body",
    );
  }
  return pdf;
}

/** Strict internal client: no redirects, no response-body error echo, and bounded PDF bytes. */
export function createArtifactRenderer(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): ArtifactRenderer {
  const endpoint = renderEndpoint(options.baseUrl);
  const token = options.token.trim();
  if (!token || token.length > 4_096) {
    throw new Error("Artifact renderer token is missing or invalid");
  }
  const request = options.fetch ?? fetch;
  const timeoutMs =
    options.timeoutMs !== undefined &&
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.min(options.timeoutMs, 60_000)
      : DEFAULT_TIMEOUT_MS;

  return Object.freeze({
    async renderMarkdown(input) {
      let response: Response;
      try {
        response = await request(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/pdf",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: input.title,
            markdown: input.markdown,
          }),
          signal: deadline(timeoutMs, input.signal),
        });
      } catch {
        throw new ArtifactRendererError(
          "UNAVAILABLE",
          "Artifact renderer is temporarily unavailable",
        );
      }
      if (
        !response.ok ||
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/pdf")
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new ArtifactRendererError(
          "UNAVAILABLE",
          "Artifact renderer could not create the PDF",
        );
      }
      return boundedPdf(response);
    },
  });
}
