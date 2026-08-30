import { describe, expect, test } from "bun:test";
import {
  type AttachmentDraftItem,
  addAttachmentFiles,
  attachmentDraftReducer,
  releaseAttachmentPreviews,
  uploadAttachmentDraft,
} from "./attachment-draft";

function file(name: string, type = "text/plain") {
  return new File([name], name, { type });
}

describe("attachment draft", () => {
  test("accepts the governed formats and caps one message at ten files", () => {
    const accepted = [
      "a.png",
      "b.jpg",
      "c.jpeg",
      "d.webp",
      "e.gif",
      "f.svg",
      "g.txt",
      "h.md",
      "i.json",
      "j.csv",
      "overflow.pdf",
    ].map((name) => file(name));

    const result = addAttachmentFiles([], accepted, () => "blob:preview");

    expect(result.items).toHaveLength(10);
    expect(result.rejected).toEqual(["overflow.pdf"]);
  });

  test("rejects unsupported extensions without creating a preview URL", () => {
    let previewCalls = 0;
    const result = addAttachmentFiles([], [file("archive.zip")], () => {
      previewCalls += 1;
      return "blob:unsafe";
    });

    expect(result.items).toEqual([]);
    expect(result.rejected).toEqual(["archive.zip"]);
    expect(previewCalls).toBe(0);
  });

  test("creates previews only for raster images, never SVG or documents", () => {
    const result = addAttachmentFiles(
      [],
      [
        file("screen.PNG", "image/png"),
        file("vector.svg", "image/svg+xml"),
        file("brief.pdf", "application/pdf"),
      ],
      (input) => `blob:${input.name}`,
    );

    expect(result.items.map((item) => item.previewUrl)).toEqual([
      "blob:screen.PNG",
      null,
      null,
    ]);
  });

  test("deduplicates the same browser file across paste and drop", () => {
    const screenshot = new File(["same"], "screen.png", {
      type: "image/png",
      lastModified: 42,
    });
    const pasted = addAttachmentFiles([], [screenshot], () => "blob:first");
    const dropped = addAttachmentFiles(
      pasted.items,
      [screenshot],
      () => "blob:duplicate",
    );

    expect(dropped.items).toHaveLength(1);
    expect(dropped.rejected).toEqual([]);
  });

  test("releases every raster object URL when a draft is discarded", () => {
    const items = addAttachmentFiles(
      [],
      [file("one.png", "image/png"), file("two.pdf", "application/pdf")],
      (input) => `blob:${input.name}`,
    ).items;
    const revoked: string[] = [];

    releaseAttachmentPreviews(items, (url) => revoked.push(url));

    expect(revoked).toEqual(["blob:one.png"]);
  });

  test("failed uploads require an explicit retry and removable items disappear", () => {
    const [item] = addAttachmentFiles(
      [],
      [file("notes.txt")],
      () => "blob:x",
    ).items;
    if (!item) throw new Error("expected draft item");

    const failed = attachmentDraftReducer([item], {
      type: "failed",
      localId: item.localId,
      error: "Сеть недоступна",
    });
    expect(failed[0]?.status).toBe("failed");

    const retried = attachmentDraftReducer(failed, {
      type: "retry",
      localId: item.localId,
    });
    expect(retried[0]?.status).toBe("queued");

    expect(
      attachmentDraftReducer(retried, {
        type: "remove",
        localId: item.localId,
      }),
    ).toEqual([]);
  });
});

describe("uploadAttachmentDraft", () => {
  test("uploads one request per file with concurrency capped at three", async () => {
    const items = addAttachmentFiles(
      [],
      Array.from({ length: 7 }, (_, index) => file(`${index}.txt`)),
      () => "blob:x",
    ).items;
    let active = 0;
    let peak = 0;
    const actions: string[] = [];

    const uploaded = await uploadAttachmentDraft({
      channelId: "channel-1",
      items,
      dispatch: (action) => actions.push(action.type),
      upload: async (_channelId, input) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return {
          id: `attachment-${input.name}`,
          filename: input.name,
          mimeType: input.type,
          size: input.size,
        };
      },
    });

    expect(peak).toBe(3);
    expect(uploaded.map((attachment) => attachment.filename)).toEqual(
      items.map((item) => item.file.name),
    );
    expect(actions.filter((action) => action === "uploading")).toHaveLength(7);
    expect(actions.filter((action) => action === "ready")).toHaveLength(7);
  });

  test("marks every failed file and refuses a partial message", async () => {
    const items = addAttachmentFiles(
      [],
      [file("ok.txt"), file("broken.txt")],
      () => "blob:x",
    ).items;
    const actions: Array<{ type: string; localId?: string }> = [];

    await expect(
      uploadAttachmentDraft({
        channelId: "channel-1",
        items,
        dispatch: (action) => actions.push(action),
        upload: async (_channelId, input) => {
          if (input.name === "broken.txt") throw new Error("offline");
          return {
            id: "attachment-ok",
            filename: input.name,
            mimeType: input.type,
            size: input.size,
          };
        },
      }),
    ).rejects.toThrow("Не удалось загрузить 1 файл");

    expect(actions.some((action) => action.type === "failed")).toBe(true);
  });

  test("reuploads ready files when a retry moves from channel A to channel B", async () => {
    let items = addAttachmentFiles(
      [],
      [file("ready.txt"), file("retry.txt")],
      () => "blob:x",
    ).items;
    const dispatch = (action: Parameters<typeof attachmentDraftReducer>[1]) => {
      items = attachmentDraftReducer(items, action);
    };
    const uploadCalls: string[] = [];
    const upload = async (channelId: string, input: File) => {
      uploadCalls.push(`${channelId}:${input.name}`);
      if (channelId === "channel-a" && input.name === "retry.txt") {
        throw new Error("offline");
      }
      return {
        id: `${channelId}-${input.name}`,
        filename: input.name,
        mimeType: input.type,
        size: input.size,
      };
    };

    await expect(
      uploadAttachmentDraft({
        channelId: "channel-a",
        items,
        dispatch,
        upload,
      }),
    ).rejects.toThrow("Не удалось загрузить 1 файл");
    const failed = items.find((item) => item.file.name === "retry.txt");
    if (!failed) throw new Error("expected failed draft item");
    dispatch({ type: "retry", localId: failed.localId });

    const deleteCalls: string[] = [];
    const uploaded = await uploadAttachmentDraft({
      channelId: "channel-b",
      items,
      dispatch,
      upload,
      deleteUploaded: async (channelId, attachmentId) => {
        deleteCalls.push(`${channelId}:${attachmentId}`);
        throw new Error("cleanup unavailable");
      },
    });

    expect(uploaded.map((attachment) => attachment.id)).toEqual([
      "channel-b-ready.txt",
      "channel-b-retry.txt",
    ]);
    expect(
      uploadCalls.filter((call) => call === "channel-b:ready.txt"),
    ).toEqual(["channel-b:ready.txt"]);
    expect(deleteCalls).toEqual(["channel-a:channel-a-ready.txt"]);
  });

  test("same-channel retry reuses ready uploads and only retries failed files", async () => {
    let items = addAttachmentFiles(
      [],
      [file("ready.txt"), file("retry.txt")],
      () => "blob:x",
    ).items;
    const dispatch = (action: Parameters<typeof attachmentDraftReducer>[1]) => {
      items = attachmentDraftReducer(items, action);
    };
    const uploadCalls: string[] = [];
    let retryAttempts = 0;
    const upload = async (channelId: string, input: File) => {
      uploadCalls.push(`${channelId}:${input.name}`);
      if (input.name === "retry.txt" && retryAttempts++ === 0) {
        throw new Error("offline");
      }
      return {
        id: `${channelId}-${input.name}`,
        filename: input.name,
        mimeType: input.type,
        size: input.size,
      };
    };

    await expect(
      uploadAttachmentDraft({
        channelId: "channel-a",
        items,
        dispatch,
        upload,
      }),
    ).rejects.toThrow("Не удалось загрузить 1 файл");
    const failed = items.find((item) => item.file.name === "retry.txt");
    if (!failed) throw new Error("expected failed draft item");
    dispatch({ type: "retry", localId: failed.localId });

    const deleteCalls: string[] = [];
    const uploaded = await uploadAttachmentDraft({
      channelId: "channel-a",
      items,
      dispatch,
      upload,
      deleteUploaded: async (oldChannelId, attachmentId) => {
        deleteCalls.push(`${oldChannelId}:${attachmentId}`);
      },
    });

    expect(uploaded.map((attachment) => attachment.id)).toEqual([
      "channel-a-ready.txt",
      "channel-a-retry.txt",
    ]);
    expect(
      uploadCalls.filter((call) => call === "channel-a:ready.txt"),
    ).toEqual(["channel-a:ready.txt"]);
    expect(
      uploadCalls.filter((call) => call === "channel-a:retry.txt"),
    ).toEqual(["channel-a:retry.txt", "channel-a:retry.txt"]);
    expect(deleteCalls).toEqual([]);
  });

  test("abort stops unscheduled workers and removes uploads completed by the cancelled attempt", async () => {
    const items = addAttachmentFiles(
      [],
      Array.from({ length: 5 }, (_, index) => file(`${index}.txt`)),
      () => "blob:x",
    ).items;
    const controller = new AbortController();
    const uploadCalls: string[] = [];
    const deleteCalls: string[] = [];

    await expect(
      uploadAttachmentDraft({
        channelId: "channel-1",
        items,
        dispatch: () => {},
        signal: controller.signal,
        upload: async (_channelId, input) => {
          uploadCalls.push(input.name);
          controller.abort();
          return {
            id: `attachment-${input.name}`,
            filename: input.name,
            mimeType: input.type,
            size: input.size,
          };
        },
        deleteUploaded: async (channelId, attachmentId) => {
          deleteCalls.push(`${channelId}:${attachmentId}`);
        },
      }),
    ).rejects.toHaveProperty("name", "AbortError");

    expect(uploadCalls).toEqual(["0.txt"]);
    expect(deleteCalls).toEqual(["channel-1:attachment-0.txt"]);
  });

  test("abort also removes a ready upload retained from an earlier partial attempt", async () => {
    const [readyDraft, queuedDraft] = addAttachmentFiles(
      [],
      [file("ready.txt"), file("queued.txt")],
      () => "blob:x",
    ).items;
    if (!readyDraft || !queuedDraft) {
      throw new Error("expected two draft items");
    }
    const items: AttachmentDraftItem[] = [
      {
        ...readyDraft,
        status: "ready",
        attachment: {
          id: "attachment-prior",
          filename: "ready.txt",
          mimeType: "text/plain",
          size: 9,
        },
        uploadedChannelId: "channel-1",
      },
      queuedDraft,
    ];
    const controller = new AbortController();
    const deleteCalls: string[] = [];

    await expect(
      uploadAttachmentDraft({
        channelId: "channel-1",
        items,
        dispatch: () => {},
        signal: controller.signal,
        upload: async (_channelId, input) => {
          controller.abort();
          return {
            id: "attachment-new",
            filename: input.name,
            mimeType: input.type,
            size: input.size,
          };
        },
        deleteUploaded: async (oldChannelId, attachmentId) => {
          deleteCalls.push(`${oldChannelId}:${attachmentId}`);
        },
      }),
    ).rejects.toHaveProperty("name", "AbortError");

    expect(deleteCalls.sort()).toEqual([
      "channel-1:attachment-new",
      "channel-1:attachment-prior",
    ]);
  });

  test("abort releases cross-channel cleanup without starting the replacement upload", async () => {
    const [draft] = addAttachmentFiles(
      [],
      [file("ready.txt")],
      () => "blob:x",
    ).items;
    if (!draft) throw new Error("expected draft item");
    const item: AttachmentDraftItem = {
      ...draft,
      status: "ready",
      attachment: {
        id: "attachment-a",
        filename: "ready.txt",
        mimeType: "text/plain",
        size: 9,
      },
      uploadedChannelId: "channel-a",
    };
    const controller = new AbortController();
    let cleanupStarted = () => {};
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const uploadCalls: string[] = [];

    const attempt = uploadAttachmentDraft({
      channelId: "channel-b",
      items: [item],
      dispatch: () => {},
      signal: controller.signal,
      upload: async (_channelId, input) => {
        uploadCalls.push(input.name);
        return {
          id: "attachment-b",
          filename: input.name,
          mimeType: input.type,
          size: input.size,
        };
      },
      deleteUploaded: async (_channelId, _attachmentId, signal) => {
        cleanupStarted();
        if (!signal) return;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    await started;
    controller.abort();

    await expect(attempt).rejects.toHaveProperty("name", "AbortError");
    expect(uploadCalls).toEqual([]);
  });

  test("does not expose File, base64, or storage keys in uploaded references", async () => {
    const items: AttachmentDraftItem[] = addAttachmentFiles(
      [],
      [file("report.pdf", "application/pdf")],
      () => "blob:x",
    ).items;

    const [uploaded] = await uploadAttachmentDraft({
      channelId: "channel-1",
      items,
      dispatch: () => {},
      upload: async () => ({
        id: "attachment-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 12,
      }),
    });

    expect(uploaded).toEqual({
      id: "attachment-1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 12,
    });
    expect(JSON.stringify(uploaded)).not.toContain("storageKey");
    expect(JSON.stringify(uploaded)).not.toContain("base64");
  });
});
