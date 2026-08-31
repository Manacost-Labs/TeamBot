import { createServer } from "node:http";

import { BoundedAdmission, QueueFullError } from "./admission.js";
import {
  extractPdfInWorker,
  PdfLimitError,
  PdfTimeoutError,
  PdfUnreadableError,
} from "./extract.js";

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const OUTER_TIMEOUT_MS = 10_000;

class InvalidRequestError extends Error {}
class BodyTooLargeError extends Error {}

function headers() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendJson(response, status, payload) {
  if (response.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    ...headers(),
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
  });
  response.end(body);
}

async function readBody(request, signal) {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 5) {
      throw new InvalidRequestError();
    }
    if (size > MAX_INPUT_BYTES) throw new BodyTooLargeError();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > MAX_INPUT_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  const pdf = Buffer.concat(chunks, size);
  if (pdf.byteLength < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new InvalidRequestError();
  }
  return pdf;
}

export function createPdfExtractorServer({
  extract = extractPdfInWorker,
  concurrency = 2,
  maxQueued = 8,
  timeoutMs = OUTER_TIMEOUT_MS,
} = {}) {
  const admission = new BoundedAdmission({ concurrency, maxQueued });
  return createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://extractor.invalid")
      .pathname;
    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (pathname !== "/extract") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    const contentType = request.headers["content-type"]
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      contentType !== "application/pdf" ||
      (request.headers["content-encoding"] &&
        request.headers["content-encoding"] !== "identity")
    ) {
      sendJson(response, 415, { error: "unsupported media type" });
      return;
    }

    const controller = new AbortController();
    const abortRequest = () =>
      controller.abort(new PdfTimeoutError("request ended"));
    const abortResponse = () => {
      if (!response.writableEnded) abortRequest();
    };
    const abortTransport = () => {
      if (!request.complete && !request.destroyed) {
        request.destroy(controller.signal.reason);
      }
    };
    request.once("aborted", abortRequest);
    response.once("close", abortResponse);
    controller.signal.addEventListener("abort", abortTransport, { once: true });
    const timer = setTimeout(
      () => controller.abort(new PdfTimeoutError("request timed out")),
      timeoutMs,
    );
    timer.unref?.();
    let release;
    try {
      release = await admission.acquire(controller.signal);
      const pdf = await readBody(request, controller.signal);
      const result = await extract(pdf, {
        signal: controller.signal,
        timeoutMs: Math.min(8_000, timeoutMs),
      });
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof QueueFullError) {
        sendJson(response, 429, { error: "extraction queue is full" });
      } else if (
        error instanceof BodyTooLargeError ||
        error instanceof PdfLimitError
      ) {
        request.resume();
        response.setHeader("connection", "close");
        sendJson(response, 413, { error: "PDF limits exceeded" });
      } else if (error instanceof InvalidRequestError) {
        sendJson(response, 400, { error: "invalid PDF request" });
      } else if (error instanceof PdfUnreadableError) {
        sendJson(response, 422, { error: "PDF is unreadable" });
      } else if (
        error instanceof PdfTimeoutError ||
        controller.signal.aborted
      ) {
        sendJson(response, 504, { error: "PDF extraction timed out" });
      } else {
        sendJson(response, 500, { error: "PDF extraction failed" });
      }
    } finally {
      clearTimeout(timer);
      request.removeListener("aborted", abortRequest);
      response.removeListener("close", abortResponse);
      controller.signal.removeEventListener("abort", abortTransport);
      release?.();
    }
  });
}
