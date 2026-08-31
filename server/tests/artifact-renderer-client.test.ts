import { describe, expect, test } from "bun:test";
import {
  ArtifactRendererError,
  createArtifactRenderer,
} from "../src/artifacts/renderer-client";

const pdf = new TextEncoder().encode("%PDF-1.7\nsmall test");

describe("artifact renderer client", () => {
  test("sends one authenticated non-redirecting request and accepts a bounded PDF", async () => {
    let received: { input: RequestInfo | URL; init?: RequestInit } | null =
      null;
    const renderer = createArtifactRenderer({
      baseUrl: "http://artifact-renderer:8090/internal/",
      token: "renderer-token",
      fetch: async (input, init) => {
        received = { input, init };
        return new Response(pdf, {
          headers: { "content-type": "application/pdf" },
        });
      },
    });

    expect(
      await renderer.renderMarkdown({ title: "Отчёт", markdown: "# Итог" }),
    ).toEqual(pdf);
    expect(String(received?.input)).toBe(
      "http://artifact-renderer:8090/internal/render",
    );
    expect(received?.init?.redirect).toBe("error");
    const receivedHeaders = received?.init?.headers as
      | Record<string, string>
      | undefined;
    expect(receivedHeaders?.authorization).toBe("Bearer renderer-token");
    expect(JSON.parse(String(received?.init?.body))).toEqual({
      title: "Отчёт",
      markdown: "# Итог",
    });
  });

  test("rejects vendor errors without echoing their response body", async () => {
    const renderer = createArtifactRenderer({
      baseUrl: "http://artifact-renderer:8090",
      token: "renderer-token",
      fetch: async () =>
        new Response("PRIVATE RENDERER DETAIL", { status: 500 }),
    });

    try {
      await renderer.renderMarkdown({ title: "Report", markdown: "Body" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactRendererError);
      expect(String(error)).not.toContain("PRIVATE RENDERER DETAIL");
    }
  });

  test("rejects a non-PDF body and oversized declared output", async () => {
    const nonPdf = createArtifactRenderer({
      baseUrl: "http://artifact-renderer:8090",
      token: "renderer-token",
      fetch: async () =>
        new Response("not a pdf", {
          headers: { "content-type": "application/pdf" },
        }),
    });
    await expect(
      nonPdf.renderMarkdown({ title: "Report", markdown: "Body" }),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });

    const oversized = createArtifactRenderer({
      baseUrl: "http://artifact-renderer:8090",
      token: "renderer-token",
      fetch: async () =>
        new Response(pdf, {
          headers: {
            "content-type": "application/pdf",
            "content-length": String(25 * 1024 * 1024 + 1),
          },
        }),
    });
    await expect(
      oversized.renderMarkdown({ title: "Report", markdown: "Body" }),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  test("refuses ambiguous endpoints and missing credentials at construction", () => {
    expect(() =>
      createArtifactRenderer({
        baseUrl: "file:///private/socket",
        token: "token",
      }),
    ).toThrow("plain HTTP(S)");
    expect(() =>
      createArtifactRenderer({
        baseUrl: "http://user:pass@renderer.invalid",
        token: "token",
      }),
    ).toThrow("plain HTTP(S)");
    expect(() =>
      createArtifactRenderer({
        baseUrl: "http://renderer.invalid",
        token: " ",
      }),
    ).toThrow("token");
  });
});
