import { describe, expect, test } from "bun:test";
import type { AttachmentUploadService } from "../src/attachments/lifecycle";
import type { AttachmentRecord } from "../src/attachments/store";
import type { Database } from "../src/db/client";
import {
  createGoogleDriveFileBridge,
  googleDriveOperationId,
} from "../src/plugins/google-drive-file-bridge";

const context = {
  actorId: "actor-a",
  botId: "bot-a",
  threadId: "thread-a",
  runId: "run-a",
};
const attachmentId = "10000000-0000-4000-8000-000000000001";

function record(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: attachmentId,
    ownerUserId: context.actorId,
    channelId: "channel-a",
    messageId: null,
    name: "Plan.md",
    mimeType: "text/markdown",
    size: 4,
    sha256: "a".repeat(64),
    storageKey: "20000000-0000-4000-8000-000000000002",
    source: "google_export",
    createdAt: new Date("2026-08-31T00:00:00Z"),
    ...overrides,
  };
}

function harness(
  options: {
    listed?: AttachmentRecord[];
    uploaded?: AttachmentRecord | null;
  } = {},
) {
  const calls: unknown[][] = [];
  const database = {
    async execute() {
      return [{ channelId: "channel-a" }];
    },
    async transaction(
      operation: (transaction: {
        execute: (...args: unknown[]) => Promise<unknown[]>;
      }) => Promise<unknown>,
    ) {
      return operation({
        async execute(...args: unknown[]) {
          calls.push(["lock", ...args]);
          return [];
        },
      });
    },
  } as unknown as Database;
  const uploads: AttachmentUploadService = {
    async reserve() {
      return {
        storageKey: "20000000-0000-4000-8000-000000000002",
        leaseToken: "30000000-0000-4000-8000-000000000003",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
    },
    async cancel() {
      return true;
    },
    async upload(...args) {
      calls.push(["upload", ...args.slice(0, 5)]);
      return options.uploaded === undefined ? record() : options.uploaded;
    },
  };
  return {
    calls,
    bridge: createGoogleDriveFileBridge({
      database,
      attachments: {
        async list() {
          return { attachments: options.listed ?? [], nextCursor: null };
        },
      },
      uploads,
      conversationAttachments: {
        async contentSource(_context, requestedId) {
          if (requestedId !== attachmentId) return null;
          return {
            attachment: {
              id: attachmentId,
              messageId: "message-a",
              name: "upload.txt",
              mimeType: "text/plain",
              size: 4,
              source: "user_upload",
              createdAt: "2026-08-31T00:00:00Z",
            },
            async openStream() {
              return new Blob(["data"]).stream();
            },
          };
        },
      },
    }),
  };
}

describe("Google Drive file bridge", () => {
  test("uses deterministic run-scoped operation ids and a database lock", async () => {
    const first = googleDriveOperationId("upload", context, [attachmentId]);
    expect(first).toBe(
      googleDriveOperationId("upload", context, [attachmentId]),
    );
    expect(first).not.toBe(
      googleDriveOperationId("upload", { ...context, actorId: "actor-b" }, [
        attachmentId,
      ]),
    );
    expect(first).not.toBe(
      googleDriveOperationId("upload", { ...context, runId: "run-b" }, [
        attachmentId,
      ]),
    );
    const { bridge, calls } = harness();
    await bridge.withOperationLock(first, async () => "done");
    expect(calls[0]?.[0]).toBe("lock");
  });

  test("recovers a deterministic import and publishes new bytes as google_export", async () => {
    const operationId = googleDriveOperationId("import", context, [
      "drive-file",
    ]);
    const existing = record({ messageId: `google-import:v1:${operationId}` });
    await expect(
      harness({ listed: [existing] }).bridge.recoverImport(
        context,
        operationId,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { attachmentId, source: "google_export" },
    });

    const { bridge, calls } = harness();
    const published = await bridge.publishImport(context, {
      operationId,
      name: "Plan.md",
      mimeType: "text/markdown",
      body: new Blob(["data"]).stream(),
    });
    expect(published).toMatchObject({ ok: true, value: { attachmentId } });
    expect(calls.find((call) => call[0] === "upload")?.[3]).toBe(
      "google_export",
    );
    expect(calls.find((call) => call[0] === "upload")?.[5]).toMatchObject({
      messageId: `google-import:v1:${operationId}`,
    });
  });

  test("returns only an attachment authorized by the conversation store", async () => {
    const bridge = harness().bridge;
    await expect(
      bridge.attachmentForUpload(context, attachmentId),
    ).resolves.toMatchObject({
      ok: true,
      value: { attachment: { id: attachmentId, name: "upload.txt" } },
    });
    await expect(
      bridge.attachmentForUpload(
        context,
        "90000000-0000-4000-8000-000000000009",
      ),
    ).resolves.toMatchObject({ ok: false });
  });
});
