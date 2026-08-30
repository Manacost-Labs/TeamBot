import { afterEach, describe, expect, test } from "bun:test";
import { deleteAttachment, uploadAttachment } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("uploadAttachment", () => {
  test("sends exactly one multipart file to the channel endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        attachment: {
          id: "attachment-1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 5,
        },
      });
    }) as typeof fetch;

    const result = await uploadAttachment(
      "channel / one",
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/channels/channel%20%2F%20one/attachments");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
    const requestBody = calls[0]?.init?.body;
    if (!(requestBody instanceof FormData)) {
      throw new Error("Expected multipart request body");
    }
    expect(requestBody.getAll("file")).toHaveLength(1);
    expect(result).toEqual({
      id: "attachment-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      size: 5,
    });
  });

  test("surfaces the server error and rejects malformed success bodies", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "Файл слишком большой" },
        { status: 413 },
      )) as unknown as typeof fetch;
    await expect(
      uploadAttachment("channel-1", new File(["x"], "x.txt")),
    ).rejects.toThrow("Файл слишком большой");

    globalThis.fetch = (async () =>
      Response.json({ attachment: {} })) as unknown as typeof fetch;
    await expect(
      uploadAttachment("channel-1", new File(["x"], "x.txt")),
    ).rejects.toThrow("Некорректный ответ сервера");
  });

  test("forwards the submit lifetime signal to fetch", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url, init) => {
      requestSignal = init?.signal;
      return Response.json({
        attachment: {
          id: "attachment-1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 5,
        },
      });
    }) as typeof fetch;

    await uploadAttachment(
      "channel-1",
      new File(["hello"], "notes.txt", { type: "text/plain" }),
      controller.signal,
    );

    expect(requestSignal).toBe(controller.signal);
  });
});

describe("deleteAttachment", () => {
  test("removes an uploaded draft by public IDs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const controller = new AbortController();
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await deleteAttachment(
      "channel / one",
      "attachment / one",
      controller.signal,
    );

    expect(calls).toEqual([
      {
        url: "/api/channels/channel%20%2F%20one/attachments/attachment%20%2F%20one",
        init: {
          method: "DELETE",
          credentials: "include",
          signal: controller.signal,
        },
      },
    ]);
  });
});
