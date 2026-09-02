import { afterEach, describe, expect, test } from "bun:test";
import {
  artifactDownloadUrl,
  artifactPreviewUrl,
  listChannelArtifacts,
  listWorkspaceArtifacts,
  readArtifactMetadata,
  readArtifactTextPreview,
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
          name: "archive.zip",
          mimeType: "application/zip",
          size: 12,
          messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
          source: "agent_generated",
        },
      })) as unknown as typeof fetch;

    await expect(
      readArtifactMetadata("channel-a", attachmentId),
    ).rejects.toThrow("некорректные данные");
  });

  test("accepts safe-source artifact formats and enforces their extension", async () => {
    let filename = "page.html";
    globalThis.fetch = (async () =>
      Response.json({
        attachment: {
          id: attachmentId,
          name: filename,
          mimeType: "text/html",
          size: 91,
          messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
          source: "agent_generated",
        },
      })) as unknown as typeof fetch;

    await expect(
      readArtifactMetadata("channel-a", attachmentId),
    ).resolves.toMatchObject({ filename: "page.html", mimeType: "text/html" });
    filename = "spoofed.txt";
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

  test("lists only validated generated artifacts for history recovery", async () => {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    globalThis.fetch = (async (input, init) => {
      request = [input, init];
      return Response.json({
        attachments: [
          {
            id: attachmentId,
            name: "report.md",
            mimeType: "text/markdown",
            size: 91,
            messageId: "artifact:export-1",
            source: "agent_generated",
          },
          {
            id: "69bb8eb0-1ac8-4c67-aeca-2362e2f507ce",
            name: "private.md",
            mimeType: "text/markdown",
            size: 12,
            messageId: null,
            source: "user_upload",
          },
          {
            id: attachmentId,
            name: "spoofed.md",
            mimeType: "text/plain",
            size: 91,
            messageId: "artifact:export-2",
            source: "agent_generated",
          },
        ],
        nextCursor: null,
      });
    }) as typeof fetch;

    await expect(listChannelArtifacts("channel-a")).resolves.toEqual([
      {
        id: attachmentId,
        filename: "report.md",
        mimeType: "text/markdown",
        size: 91,
        messageId: "artifact:export-1",
        source: "agent_generated",
      },
    ]);
    expect(request?.[0]).toBe("/api/channels/channel-a/attachments?limit=50");
    expect(request?.[1]?.credentials).toBe("include");
  });

  test("reads inert text previews with credentials and a display cap", async () => {
    globalThis.fetch = (async (_input, init) => {
      expect(init?.credentials).toBe("include");
      return new Response("a".repeat(100_100), {
        headers: { "content-type": "text/markdown" },
      });
    }) as typeof fetch;

    expect(
      (await readArtifactTextPreview("channel-a", attachmentId)).length,
    ).toBe(100_000);
  });

  test("lists validated artifacts across channels with a bounded cursor request", async () => {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    globalThis.fetch = (async (input, init) => {
      request = [input, init];
      return Response.json({
        attachments: [
          {
            id: attachmentId,
            channelId: "channel-a",
            name: "report.md",
            mimeType: "text/markdown",
            size: 91,
            messageId: "artifact:export-1",
            source: "agent_generated",
            createdAt: "2026-08-30T12:00:00.000Z",
          },
          {
            id: attachmentId,
            channelId: "channel-a",
            name: "upload.md",
            mimeType: "text/markdown",
            size: 91,
            messageId: null,
            source: "user_upload",
            createdAt: "2026-08-30T12:00:00.000Z",
          },
          {
            id: attachmentId,
            channelId: "channel-a",
            name: "bad.md",
            mimeType: "text/plain",
            size: 91,
            messageId: "artifact:export-2",
            source: "agent_generated",
            createdAt: "2026-08-30T12:00:00.000Z",
          },
        ],
        nextCursor: "next-page",
      });
    }) as typeof fetch;

    await expect(
      listWorkspaceArtifacts({ cursor: "page-one", limit: 25 }),
    ).resolves.toEqual({
      artifacts: [
        {
          id: attachmentId,
          channelId: "channel-a",
          filename: "report.md",
          mimeType: "text/markdown",
          size: 91,
          messageId: "artifact:export-1",
          source: "agent_generated",
          createdAt: "2026-08-30T12:00:00.000Z",
        },
      ],
      nextCursor: "next-page",
    });
    expect(request?.[0]).toBe("/api/results?cursor=page-one&limit=25");
    expect(request?.[1]?.credentials).toBe("include");
  });

  test("rejects a malformed results envelope", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        attachments: [],
        nextCursor: 42,
      })) as unknown as typeof fetch;

    await expect(listWorkspaceArtifacts()).rejects.toThrow(
      "некорректную страницу",
    );
  });
});
