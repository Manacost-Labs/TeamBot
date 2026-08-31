import { describe, expect, test } from "bun:test";
import {
  createPdfExtractor,
  PdfExtractorError,
} from "../src/attachments/pdf-extractor-client";

const pdf = new TextEncoder().encode("%PDF-1.7\ntest");

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("PDF extractor client", () => {
  test("sends only raw PDF bytes to the internal endpoint", async () => {
    let received: { input: RequestInfo | URL; init?: RequestInit } | null =
      null;
    const extractor = createPdfExtractor({
      baseUrl: "http://pdf-extractor:8080/internal/",
      fetch: async (input, init) => {
        received = { input, init };
        return Response.json({ text: "Hello", truncated: false });
      },
    });

    expect(
      await extractor.extractText({ stream: streamOf(pdf), size: pdf.length }),
    ).toEqual({ text: "Hello", truncated: false });
    expect(String(received?.input)).toBe(
      "http://pdf-extractor:8080/internal/extract",
    );
    expect(received?.init?.redirect).toBe("error");
    expect(received?.init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/pdf",
    });
    expect(new Uint8Array(received?.init?.body as ArrayBuffer)).toEqual(pdf);
    expect(JSON.stringify(received)).not.toContain("attachmentId");
    expect(JSON.stringify(received)).not.toContain("actorId");
  });

  test("rejects oversized declared input before reading or making a request", async () => {
    let cancelled = 0;
    let requests = 0;
    const extractor = createPdfExtractor({
      baseUrl: "http://pdf-extractor:8080",
      fetch: async () => {
        requests += 1;
        return Response.json({ text: "unexpected", truncated: false });
      },
    });
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1;
      },
    });
    await expect(
      extractor.extractText({ stream, size: 25 * 1024 * 1024 + 1 }),
    ).rejects.toBeInstanceOf(PdfExtractorError);
    expect(requests).toBe(0);
    expect(cancelled).toBe(1);
  });

  test("cancels a hanging storage stream at the outer deadline", async () => {
    let cancelled = 0;
    let requests = 0;
    const extractor = createPdfExtractor({
      baseUrl: "http://pdf-extractor:8080",
      timeoutMs: 20,
      fetch: async () => {
        requests += 1;
        return Response.json({ text: "unexpected", truncated: false });
      },
    });
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled += 1;
      },
    });
    await expect(
      extractor.extractText({ stream, size: pdf.length }),
    ).rejects.toBeInstanceOf(PdfExtractorError);
    expect(requests).toBe(0);
    expect(cancelled).toBe(1);
  });

  test("cancels a hanging extractor response at the same outer deadline", async () => {
    let cancelled = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("deadline")), 20);
    const extractor = createPdfExtractor({
      baseUrl: "http://pdf-extractor:8080",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              cancelled += 1;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    try {
      await expect(
        extractor.extractText({
          stream: streamOf(pdf),
          size: pdf.length,
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(PdfExtractorError);
      expect(cancelled).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  });

  test("does not echo extractor errors and rejects oversized text output", async () => {
    const vendorError = createPdfExtractor({
      baseUrl: "http://pdf-extractor:8080",
      fetch: async () => new Response("PRIVATE PDF DETAIL", { status: 500 }),
    });
    try {
      await vendorError.extractText({
        stream: streamOf(pdf),
        size: pdf.length,
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfExtractorError);
      expect(String(error)).not.toContain("PRIVATE PDF DETAIL");
    }

    const invalidOutput = createPdfExtractor({
      baseUrl: "http://pdf-extractor:8080",
      fetch: async () =>
        Response.json({ text: "x".repeat(1_000_001), truncated: true }),
    });
    await expect(
      invalidOutput.extractText({ stream: streamOf(pdf), size: pdf.length }),
    ).rejects.toBeInstanceOf(PdfExtractorError);
  });

  test("refuses ambiguous service addresses", () => {
    expect(() =>
      createPdfExtractor({ baseUrl: "file:///private/pdf" }),
    ).toThrow("plain HTTP(S)");
    expect(() =>
      createPdfExtractor({ baseUrl: "http://user:pass@pdf.invalid" }),
    ).toThrow("plain HTTP(S)");
  });
});
