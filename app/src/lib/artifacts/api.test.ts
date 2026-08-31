import { afterEach, describe, expect, test } from "bun:test";
import {
  artifactDownloadUrl,
  artifactPreviewUrl,
  readArtifactMetadata,
  readMarkdownArtifactPreview,
} from "./api";

const originalFetch = globalThis.fetch;
const attachmentId = "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("artifact API", () => {
  test("derives private endpoints from encoded public ids", () => {
    expect(artifactPreviewUrl("channel / one", attachmentId)).toBe(
      `/api/channels/channel%20%2F%20one/attachments/${attachmentId}/preview`,
    );
    expect(artifactDownloadUrl("channel / one", attachmentId)).toBe(
      `/api/channels/channel%20%2F%20one/attachments/${attachmentId}/download`,
    );
  });

  test("uses authenticated authoritative metadata", async () => {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    globalThis.fetch = (async (input, init) => {
      request = [input, init];
      return Response.json({
        attachment: {
          id: attachmentId,
          name: "server-name.md",
          mimeType: "text/markdown",
          size: 91,
          messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
          source: "agent_generated",
        },
      });
    }) as typeof fetch;

    await expect(
      readArtifactMetadata("channel-a", attachmentId),
    ).resolves.toEqual({
      id: attachmentId,
      filename: "server-name.md",
      mimeType: "text/markdown",
      size: 91,
      messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
      source: "agent_generated",
    });
    expect(request?.[1]?.credentials).toBe("include");
  });

  test("rejects mismatched ids and unsupported server MIME types", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        attachment: {
          id: "69bb8eb0-1ac8-4c67-aeca-2362e2f507ce",
          name: "active.html",
          mimeType: "text/html",
          size: 12,
          messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
          source: "agent_generated",
        },
      })) as unknown as typeof fetch;

    await expect(
      readArtifactMetadata("channel-a", attachmentId),
    ).rejects.toThrow("некорректные данные");
  });

  test("rejects user uploads even when their ids and MIME look valid", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        attachment: {
          id: attachmentId,
          name: "server-name.md",
          mimeType: "text/markdown",
          size: 91,
          messageId: null,
          source: "user_upload",
        },
      })) as unknown as typeof fetch;

    await expect(
      readArtifactMetadata("channel-a", attachmentId),
    ).rejects.toThrow("некорректные данные");
  });

  test("reads markdown previews with credentials and a display cap", async () => {
    globalThis.fetch = (async (_input, init) => {
      expect(init?.credentials).toBe("include");
      return new Response("a".repeat(100_100), {
        headers: { "content-type": "text/markdown" },
      });
    }) as typeof fetch;

    expect(
      (await readMarkdownArtifactPreview("channel-a", attachmentId)).length,
    ).toBe(100_000);
  });
});
