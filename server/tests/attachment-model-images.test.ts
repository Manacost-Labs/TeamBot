import { describe, expect, test } from "bun:test";
import { RunAgentInputSchema } from "@ag-ui/client";
import {
  createAttachmentModelInputPreparer,
  projectRunInputForModel,
} from "../src/attachments/model-images";
import type {
  ConversationAttachmentContentSource,
  ConversationAttachmentModelStore,
  TrustedAttachmentToolContext,
} from "../src/attachments/tool-store";

const attachmentId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const bytes = (length: number, byte = 7): Uint8Array =>
  new Uint8Array(length).fill(byte);

function source(
  id: string,
  mimeType: string,
  content: Uint8Array,
  declaredSize = content.byteLength,
): ConversationAttachmentContentSource {
  return {
    attachment: {
      id,
      messageId: "message-1",
      name: "server-name-must-not-reach-model.png",
      mimeType,
      size: declaredSize,
      source: "user_upload",
      createdAt: "2026-08-30T10:00:00.000Z",
    },
    async openStream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content);
          controller.close();
        },
      });
    },
  };
}

function runInput(ids: string[]) {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    messages: [
      {
        id: "older-user",
        role: "user" as const,
        content: [
          {
            type: "binary" as const,
            id: attachmentId(99),
            mimeType: "image/png",
          },
        ],
      },
      {
        id: "latest-user",
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Compare these images." },
          ...ids.map((id) => ({
            type: "binary" as const,
            id,
            mimeType: "image/gif",
            data: "CLIENT_BASE64_MUST_NOT_BE_TRUSTED",
            url: "https://private.invalid/client-image",
            filename: "client-name-must-not-reach-model.gif",
          })),
        ],
      },
    ],
  };
}

function fakeStore(
  entries: Map<string, ConversationAttachmentContentSource>,
  calls: Array<{ context: TrustedAttachmentToolContext; id: string }>,
): ConversationAttachmentModelStore {
  return {
    async contentSource(context, id) {
      calls.push({ context, id });
      return entries.get(id) ?? null;
    },
  };
}

describe("attachment model image preparation", () => {
  test("adds only server-authorized image bytes to the latest user turn", async () => {
    const id = attachmentId(1);
    const calls: Array<{ context: TrustedAttachmentToolContext; id: string }> =
      [];
    const store = fakeStore(
      new Map([[id, source(id, "image/png", bytes(4, 42))]]),
      calls,
    );
    const prepare = createAttachmentModelInputPreparer(store, "actor-1");
    const input = runInput([id]);

    const prepared = await prepare("bot-1", input);

    expect(RunAgentInputSchema.safeParse(prepared).success).toBe(true);
    expect(input.messages[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: "CLIENT_BASE64_MUST_NOT_BE_TRUSTED",
        }),
      ]),
    );
    expect(calls).toEqual([
      {
        context: {
          actorId: "actor-1",
          botId: "bot-1",
          threadId: "thread-1",
        },
        id,
      },
    ]);
    const serialized = JSON.stringify(prepared);
    expect(serialized).toContain(Buffer.from(bytes(4, 42)).toString("base64"));
    expect(serialized).toContain('"mimeType":"image/png"');
    expect(serialized).not.toContain("CLIENT_BASE64_MUST_NOT_BE_TRUSTED");
    expect(serialized).not.toContain("private.invalid");
    expect(serialized).not.toContain("client-name-must-not-reach-model");
    expect(serialized).not.toContain("server-name-must-not-reach-model");
  });

  test("enforces supported MIME, count, per-file, total, and actual byte limits", async () => {
    const calls: Array<{ context: TrustedAttachmentToolContext; id: string }> =
      [];
    const entries = new Map<string, ConversationAttachmentContentSource>();
    for (let index = 1; index <= 8; index += 1) {
      const id = attachmentId(index);
      entries.set(id, source(id, "image/png", bytes(4, index)));
    }
    entries.set(
      attachmentId(1),
      source(attachmentId(1), "image/gif", bytes(4)),
    );
    entries.set(
      attachmentId(2),
      source(attachmentId(2), "image/png", bytes(6), 4),
    );
    entries.set(
      attachmentId(3),
      source(attachmentId(3), "image/png", bytes(4), 6),
    );
    const prepare = createAttachmentModelInputPreparer(
      fakeStore(entries, calls),
      "actor-1",
      { maxImages: 2, maxBytesPerImage: 5, maxTotalBytes: 8 },
    );

    const prepared = await prepare(
      "bot-1",
      runInput(
        Array.from({ length: 8 }, (_, index) => attachmentId(index + 1)),
      ),
    );
    const latest = prepared.messages.at(-1);
    const imageParts = Array.isArray(latest?.content)
      ? latest.content.filter((part) => part.type === "image")
      : [];

    expect(imageParts).toHaveLength(2);
    expect(calls.map((call) => call.id)).toEqual([
      attachmentId(1),
      attachmentId(2),
      attachmentId(3),
      attachmentId(4),
      attachmentId(5),
    ]);
  });

  test("falls back to safe text when authorization or blob reading fails", async () => {
    const denied = attachmentId(1);
    const broken = attachmentId(2);
    const store: ConversationAttachmentModelStore = {
      async contentSource(_context, id) {
        if (id === denied) return null;
        return {
          ...source(id, "image/webp", bytes(1)),
          async openStream() {
            throw new Error("private storage path /do/not/leak");
          },
        };
      },
    };

    const prepared = await createAttachmentModelInputPreparer(store, "actor-1")(
      "bot-1",
      runInput([denied, broken]),
    );
    const serialized = JSON.stringify(prepared);

    expect(serialized).toContain("Compare these images.");
    expect(serialized).toContain(denied);
    expect(serialized).toContain(broken);
    expect(serialized).not.toContain("/do/not/leak");
    expect(serialized).not.toContain('"type":"image"');
  });

  test("abandons a stalled private blob read at the configured deadline", async () => {
    const id = attachmentId(1);
    const stalled = source(id, "image/png", bytes(1));
    const store: ConversationAttachmentModelStore = {
      async contentSource() {
        return {
          ...stalled,
          async openStream() {
            return new ReadableStream<Uint8Array>({
              pull() {
                // Intentionally never produce bytes: the model boundary must cancel this read.
              },
            });
          },
        };
      },
    };
    const startedAt = Date.now();

    const prepared = await createAttachmentModelInputPreparer(
      store,
      "actor-1",
      { readTimeoutMs: 10 },
    )("bot-1", runInput([id]));

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(JSON.stringify(prepared)).not.toContain('"type":"image"');
  });

  test("applies one run deadline to authorization and metadata lookup", async () => {
    const id = attachmentId(1);
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const store: ConversationAttachmentModelStore = {
      async contentSource(_context, _attachmentId, signal) {
        calls += 1;
        receivedSignal = signal;
        return new Promise<ConversationAttachmentContentSource | null>(() => {
          // A stuck database/storage lookup must not hold the model run indefinitely.
        });
      },
    };
    const startedAt = Date.now();

    const prepared = await createAttachmentModelInputPreparer(
      store,
      "actor-1",
      { readTimeoutMs: 10 },
    )("bot-1", runInput([id, attachmentId(2), attachmentId(3)]));

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(calls).toBe(1);
    expect(receivedSignal?.aborted).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain('"type":"image"');
  });

  test("removes client-provided image URLs and data even without a model store", () => {
    const projected = projectRunInputForModel(runInput([attachmentId(1)]));
    const serialized = JSON.stringify(projected);

    expect(serialized).toContain(attachmentId(1));
    expect(serialized).not.toContain("CLIENT_BASE64_MUST_NOT_BE_TRUSTED");
    expect(serialized).not.toContain("private.invalid");
    expect(serialized).not.toContain("image/gif");
  });
});
