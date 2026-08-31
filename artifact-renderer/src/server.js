import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { ContentLimitError } from "./markdown.js";
import {
  BoundedRenderQueue,
  QueueFullError,
  RenderTimeoutError,
} from "./queue.js";

export const MAX_MARKDOWN_BYTES = 1024 * 1024;
// JSON may expand one source byte to a six-byte Unicode escape. This bounds transport overhead
// without rejecting Markdown that the public tool contract already accepted.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_TITLE_CODEPOINTS = 200;

class BodyTooLargeError extends Error {}
class InvalidRequestError extends Error {}

function hasValidToken(request, expectedToken) {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    return false;
  }
  const actual = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBoundedBody(request) {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new InvalidRequestError();
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function validateJob(body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidRequestError();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequestError();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, "markdown") ||
    !Object.hasOwn(value, "title") ||
    typeof value.markdown !== "string" ||
    typeof value.title !== "string" ||
    [...value.title].length > MAX_TITLE_CODEPOINTS
  ) {
    throw new InvalidRequestError();
  }
  if (Buffer.byteLength(value.markdown, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new ContentLimitError();
  }
  return { markdown: value.markdown, title: value.title };
}

function baseHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    ...baseHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
  });
  response.end(body);
}

function validPdf(value) {
  const pdf = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  return pdf.byteLength <= MAX_OUTPUT_BYTES &&
    pdf.subarray(0, 5).toString("ascii") === "%PDF-"
    ? pdf
    : null;
}

export function createArtifactServer({
  token,
  render,
  concurrency = 2,
  maxQueued = 32,
  timeoutMs = 30_000,
}) {
  if (typeof token !== "string" || token.length === 0)
    throw new TypeError("renderer token is required");
  const queue = new BoundedRenderQueue({
    run: render,
    concurrency,
    maxQueued,
    timeoutMs,
  });

  return createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://renderer.invalid")
      .pathname;
    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (pathname !== "/render") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (!hasValidToken(request, token)) {
      response.setHeader("www-authenticate", "Bearer");
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const contentType = request.headers["content-type"]
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      contentType !== "application/json" ||
      (request.headers["content-encoding"] &&
        request.headers["content-encoding"] !== "identity")
    ) {
      sendJson(response, 415, { error: "unsupported media type" });
      return;
    }

    try {
      const job = validateJob(await readBoundedBody(request));
      const rendered = await queue.submit(job);
      const pdf = validPdf(rendered);
      if (!pdf) throw new Error("invalid renderer output");
      response.writeHead(200, {
        ...baseHeaders(),
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="document.pdf"',
        "content-length": pdf.byteLength,
      });
      response.end(pdf);
    } catch (error) {
      if (
        error instanceof BodyTooLargeError ||
        error instanceof ContentLimitError
      ) {
        request.resume();
        response.setHeader("connection", "close");
        sendJson(response, 413, { error: "document too large" });
      } else if (error instanceof InvalidRequestError) {
        sendJson(response, 400, { error: "invalid request" });
      } else if (error instanceof QueueFullError) {
        sendJson(response, 429, { error: "render queue is full" });
      } else if (error instanceof RenderTimeoutError) {
        sendJson(response, 504, { error: "render timed out" });
      } else {
        sendJson(response, 500, { error: "render failed" });
      }
    }
  });
}
