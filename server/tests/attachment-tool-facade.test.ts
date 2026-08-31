import { describe, expect, test } from "bun:test";
import {
  type ConversationAttachmentTools,
  createConversationAttachmentTools,
} from "../src/attachments/tool-facade";
import type { PdfExtractor } from "../src/attachments/pdf-extractor-client";
import type {
  ConversationAttachmentToolStore,
  TrustedAttachmentToolContext,
} from "../src/attachments/tool-store";

const context: TrustedAttachmentToolContext = {
  actorId: "user-a",
  botId: "bot-a",
  threadId: "thread-a",
};

const attachment = {
  id: "10000000-0000-4000-8000-000000000001",
  messageId: "message-a",
  name: "notes.txt",
  mimeType: "text/plain",
  size: 12,
  source: "user_upload" as const,
  createdAt: "2026-08-30T10:00:00.000Z",
};

const notFound = {
  ok: false,
  error: {
    code: "NOT_FOUND",
    message: "Conversation attachment was not found.",
  },
} as const;

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function fakeStore(
  overrides: Partial<ConversationAttachmentToolStore> = {},
): ConversationAttachmentToolStore {
  return {
    async list() {
      return { attachments: [attachment], nextCursor: null };
    },
    async metadata(_context, attachmentId) {
      return attachmentId === attachment.id ? attachment : null;
    },
    async textSource(_context, attachmentId) {
      return attachmentId === attachment.id
        ? { attachment, openStream: async () => streamOf("hello") }
        : null;
    },
    ...overrides,
  };
}

function tools(
  overrides: Partial<ConversationAttachmentToolStore> = {},
  limits: Parameters<typeof createConversationAttachmentTools>[1] = {},
  pdfExtractor?: PdfExtractor,
): ConversationAttachmentTools {
  return createConversationAttachmentTools(
    fakeStore(overrides),
    limits,
    pdfExtractor,
  );
}

describe("conversation attachment tool envelopes", () => {
  test("lists only bounded, content-free public metadata", async () => {
    const result = await tools().listConversationAttachments(context, {
      cursor: "page-a",
      limit: 500,
    });

    expect(result).toEqual({
      ok: true,
      value: { attachments: [attachment], nextCursor: null },
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["storageKey", "ownerUserId", "sha256", "base64"])
      expect(serialized).not.toContain(forbidden);
  });

  test("uses one indistinguishable not-found envelope for malformed, missing and foreign ids", async () => {
    const foreignStore = fakeStore({
      async metadata() {
        return null;
      },
      async textSource() {
        return null;
      },
    });
    const facade = createConversationAttachmentTools(foreignStore);

    expect(
      await facade.readAttachmentMetadata(context, {
        attachmentId: "not-a-uuid",
      }),
    ).toEqual(notFound);
    expect(
      await facade.readAttachmentMetadata(context, {
        attachmentId: "10000000-0000-4000-8000-000000000099",
      }),
    ).toEqual(notFound);
    expect(
      await facade.readAttachmentText(context, {
        attachmentId: "10000000-0000-4000-8000-000000000099",
      }),
    ).toEqual(notFound);
  });

  test("rejects invalid pagination without echoing input", async () => {
    const result = await tools().listConversationAttachments(context, {
      cursor: "x".repeat(4_097),
      limit: -1,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "Invalid tool arguments." },
    });
    expect(JSON.stringify(result)).not.toContain("xxxx");
  });

  test("rejects authority-shaped and invalid text arguments at the boundary", async () => {
    expect(
      await tools().listConversationAttachments(context, {
        channelId: "foreign-channel",
      }),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "Invalid tool arguments." },
    });
    expect(
      await tools().readAttachmentText(context, {
        attachmentId: attachment.id,
        cursor: -1,
      }),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "Invalid tool arguments." },
    });
  });
});

describe("bounded text extraction", () => {
  test("pages by Unicode code point and never splits surrogate pairs", async () => {
    const facade = tools({
      async textSource() {
        return {
          attachment,
          openStream: async () => streamOf("A😀БC"),
        };
      },
    });

    const first = await facade.readAttachmentText(context, {
      attachmentId: attachment.id,
      maxChars: 2,
    });
    const second = await facade.readAttachmentText(context, {
      attachmentId: attachment.id,
      cursor: 2,
      maxChars: 2,
    });

    expect(first).toEqual({
      ok: true,
      value: {
        attachment,
        text: "A😀",
        cursor: 0,
        nextCursor: 2,
        truncated: true,
      },
    });
    expect(second).toEqual({
      ok: true,
      value: {
        attachment,
        text: "БC",
        cursor: 2,
        nextCursor: null,
        truncated: false,
      },
    });
  });

  test("caps one response at 24,000 characters and total extraction at 1,000,000", async () => {
    const facade = tools({
      async textSource() {
        return {
          attachment,
          openStream: async () => streamOf("a".repeat(1_000_100)),
        };
      },
    });

    const page = await facade.readAttachmentText(context, {
      attachmentId: attachment.id,
      cursor: 990_000,
      maxChars: 99_999,
    });

    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("expected text page");
    expect(page.value.text).toHaveLength(10_000);
    expect(page.value.nextCursor).toBeNull();
    expect(page.value.truncated).toBe(true);
  });

  test("does not let injected configuration raise the hard extraction cap", async () => {
    const facade = tools({}, { maxTotalTextCodePoints: 2_000_000 });

    expect(
      await facade.readAttachmentText(context, {
        attachmentId: attachment.id,
        cursor: 1_000_001,
      }),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "Invalid tool arguments." },
    });
  });

  test("returns a stable unsupported-type result without opening binary content", async () => {
    let opened = 0;
    const facade = tools({
      async textSource() {
        return {
          attachment: { ...attachment, mimeType: "application/pdf" },
          async openStream() {
            opened += 1;
            return streamOf("%PDF-secret");
          },
        };
      },
    });

    expect(
      await facade.readAttachmentText(context, {
        attachmentId: attachment.id,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "This attachment does not have readable text.",
      },
    });
    expect(opened).toBe(0);
  });

  test("reads an authorized PDF through the byte-only extractor and preserves paging", async () => {
    let opened = 0;
    let extracted = 0;
    const pdfAttachment = {
      ...attachment,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 12,
    };
    const extractor: PdfExtractor = {
      async extractText(input) {
        extracted += 1;
        expect(input.size).toBe(pdfAttachment.size);
        expect(input.signal).toBeInstanceOf(AbortSignal);
        return { text: "A😀БC", truncated: false };
      },
    };
    const facade = tools(
      {
        async textSource() {
          return {
            attachment: pdfAttachment,
            async openStream() {
              opened += 1;
              return streamOf("%PDF-1.7\n");
            },
          };
        },
      },
      {},
      extractor,
    );

    expect(
      await facade.readAttachmentText(context, {
        attachmentId: attachment.id,
        maxChars: 2,
      }),
    ).toEqual({
      ok: true,
      value: {
        attachment: pdfAttachment,
        text: "A😀",
        cursor: 0,
        nextCursor: 2,
        truncated: true,
      },
    });
    expect(opened).toBe(1);
    expect(extracted).toBe(1);
  });

  test("does not open bytes or call the extractor before conversation authorization", async () => {
    let extracted = 0;
    const facade = tools(
      {
        async textSource(receivedContext) {
          expect(receivedContext).toEqual(context);
          return null;
        },
      },
      {},
      {
        async extractText() {
          extracted += 1;
          return { text: "private", truncated: false };
        },
      },
    );

    expect(
      await facade.readAttachmentText(context, {
        attachmentId: attachment.id,
      }),
    ).toEqual(notFound);
    expect(extracted).toBe(0);
  });

  test("bounds a stalled reader with a content-free unavailable result and cancels it", async () => {
    let cancelled = 0;
    const facade = tools(
      {
        async textSource() {
          return {
            attachment,
            openStream: async () =>
              new ReadableStream<Uint8Array>({
                pull() {
                  return new Promise(() => {});
                },
                cancel() {
                  cancelled += 1;
                },
              }),
          };
        },
      },
      { textReadTimeoutMs: 20 },
    );

    expect(
      await facade.readAttachmentText(context, {
        attachmentId: attachment.id,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Attachment text is temporarily unavailable.",
      },
    });
    await Bun.sleep(0);
    expect(cancelled).toBe(1);
  });

  test("keeps the limiter slot until a late-opened stream is cancelled", async () => {
    let resolveLateStream:
      | ((stream: ReadableStream<Uint8Array>) => void)
      | null = null;
    const lateStream = new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveLateStream = resolve;
    });
    let openCalls = 0;
    let cancelled = 0;
    const facade = tools(
      {
        async textSource() {
          return {
            attachment,
            async openStream() {
              openCalls += 1;
              if (openCalls === 1) return lateStream;
              return streamOf("recovered");
            },
          };
        },
      },
      {
        maxConcurrentTextReads: 1,
        maxQueuedTextReads: 0,
        textReadTimeoutMs: 20,
      },
    );

    expect(
      await facade.readAttachmentText(context, {
        attachmentId: attachment.id,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Attachment text is temporarily unavailable.",
      },
    });

    expect(
      await facade.readAttachmentText(context, {
        attachmentId: attachment.id,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Attachment text is temporarily unavailable.",
      },
    });
    expect(openCalls).toBe(1);

    resolveLateStream?.(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1;
        },
      }),
    );
    await Bun.sleep(10);
    expect(cancelled).toBe(1);

    const recovered = await facade.readAttachmentText(context, {
      attachmentId: attachment.id,
    });
    expect(recovered.ok).toBe(true);
    expect(openCalls).toBe(2);
  });

  test("limits parallel extraction and rejects excess queued work", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const facade = tools(
      {
        async textSource() {
          return {
            attachment,
            openStream: async () =>
              new ReadableStream<Uint8Array>({
                async pull(controller) {
                  active += 1;
                  peak = Math.max(peak, active);
                  await new Promise<void>((resolve) => releases.push(resolve));
                  active -= 1;
                  controller.enqueue(new TextEncoder().encode("ok"));
                  controller.close();
                },
              }),
          };
        },
      },
      {
        maxConcurrentTextReads: 2,
        maxQueuedTextReads: 1,
        textReadTimeoutMs: 1_000,
      },
    );

    const reads = Array.from({ length: 4 }, () =>
      facade.readAttachmentText(context, { attachmentId: attachment.id }),
    );
    await Bun.sleep(10);
    expect(peak).toBe(2);
    expect(await reads[3]).toEqual({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Attachment text is temporarily unavailable.",
      },
    });
    for (const release of releases.splice(0)) release();
    await Bun.sleep(10);
    for (const release of releases.splice(0)) release();
    const completed = await Promise.all(reads.slice(0, 3));
    expect(completed.every((result) => result.ok)).toBe(true);
    expect(peak).toBe(2);
  });
});
