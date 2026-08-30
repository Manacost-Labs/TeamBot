import { describe, expect, test } from "bun:test";
import {
  attachmentRefsFromContent,
  buildAttachmentMessageContent,
  textFromMessageContent,
} from "./message-content";

describe("attachment message content", () => {
  test("builds text plus exact opaque AG-UI binary references", () => {
    const content = buildAttachmentMessageContent("  Проверь отчёт  ", [
      {
        id: "attachment-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
      },
    ]);

    expect(content).toEqual([
      { type: "text", text: "Проверь отчёт" },
      {
        type: "binary",
        id: "attachment-1",
        mimeType: "application/pdf",
        filename: "report.pdf",
      },
    ]);
    expect(JSON.stringify(content)).not.toContain("size");
    expect(JSON.stringify(content)).not.toContain("storageKey");
  });

  test("allows an attachment-only user message", () => {
    const content = buildAttachmentMessageContent("", [
      {
        id: "attachment-image",
        filename: "screen.png",
        mimeType: "image/png",
      },
    ]);

    expect(content).toEqual([
      {
        type: "binary",
        id: "attachment-image",
        mimeType: "image/png",
        filename: "screen.png",
      },
    ]);
  });

  test("reads only valid binary IDs and text from untrusted content", () => {
    const content = [
      { type: "text", text: "Сравни" },
      {
        type: "binary",
        id: "safe-id",
        mimeType: "image/png",
        filename: "safe.png",
        data: "must-not-be-read",
      },
      { type: "binary", id: "", mimeType: "image/png", filename: "bad.png" },
      { type: "binary", id: "bad", mimeType: "", filename: "bad.png" },
    ];

    expect(textFromMessageContent(content)).toBe("Сравни");
    expect(attachmentRefsFromContent(content)).toEqual([
      {
        type: "binary",
        id: "safe-id",
        mimeType: "image/png",
        filename: "safe.png",
      },
    ]);
  });
});
