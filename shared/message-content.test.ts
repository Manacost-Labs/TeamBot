import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_ACCESS_MARKER,
  attachmentIdsFromMessageContent,
  projectMessageContent,
} from "./message-content";

const attachmentId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

describe("safe AG-UI message content projection", () => {
  test("preserves plain string content exactly", () => {
    expect(projectMessageContent("  keep my spacing  ", "user")).toBe(
      "  keep my spacing  ",
    );
  });

  test("keeps only text and bounded attachment ids from structured user content", () => {
    const projected = projectMessageContent(
      [
        { type: "text", text: "Please review this." },
        {
          type: "binary",
          id: attachmentId(1),
          data: "PRIVATE_BASE64_BYTES",
          url: "https://private.invalid/blob",
          filename: "private-name.pdf",
          mimeType: "application/pdf",
          storageKey: "private/storage/key",
        },
        { type: "text", text: "Focus on clarity." },
        { type: "binary", id: "../../not-an-attachment" },
        ...Array.from({ length: 12 }, (_, index) => ({
          type: "binary",
          id: attachmentId(index + 2),
        })),
      ],
      "user",
    );

    expect(projected).toContain("Please review this.\nFocus on clarity.");
    expect(projected).toContain(ATTACHMENT_ACCESS_MARKER);
    expect(projected).toContain(attachmentId(1));
    expect(projected).toContain(attachmentId(10));
    expect(projected).not.toContain(attachmentId(11));
    expect(projected).not.toContain("[object Object]");
    expect(projected).not.toContain("PRIVATE_BASE64_BYTES");
    expect(projected).not.toContain("private.invalid");
    expect(projected).not.toContain("private-name.pdf");
    expect(projected).not.toContain("application/pdf");
    expect(projected).not.toContain("private/storage/key");
    expect(projected).not.toContain("../../not-an-attachment");
  });

  test("makes an attachment-only user message non-empty without exposing metadata", () => {
    const projected = projectMessageContent(
      [
        {
          type: "binary",
          id: attachmentId(1),
          data: "PRIVATE_BASE64_BYTES",
          filename: "private-name.png",
        },
      ],
      "user",
    );

    expect(projected).toBe(`[${ATTACHMENT_ACCESS_MARKER}: ${attachmentId(1)}]`);
    expect(projected).not.toContain("PRIVATE_BASE64_BYTES");
    expect(projected).not.toContain("private-name.png");
  });

  test("system and developer content never carries attachment references", () => {
    const content = [
      { type: "text", text: "Trusted text only." },
      { type: "binary", id: attachmentId(1), data: "PRIVATE_BASE64_BYTES" },
    ];

    expect(projectMessageContent(content, "system")).toBe("Trusted text only.");
    expect(projectMessageContent(content, "developer")).toBe(
      "Trusted text only.",
    );
  });

  test("extracts only bounded unique opaque ids and ignores modern image URLs", () => {
    const content = [
      { type: "binary", id: attachmentId(1) },
      { type: "binary", id: attachmentId(1), data: "duplicate" },
      {
        type: "image",
        source: { type: "url", value: "https://private.invalid/image.png" },
      },
      { type: "binary", id: "not-a-uuid" },
    ];

    expect(attachmentIdsFromMessageContent(content)).toEqual([attachmentId(1)]);
    expect(projectMessageContent(content, "user")).not.toContain(
      "private.invalid",
    );
  });
});
