import { afterEach, describe, expect, test } from "bun:test";
import { ClientTimeoutError, client, tryClient } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("client transport deadlines", () => {
  test("aborts and rejects a request that exceeds its deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          { once: true },
        );
      });
    }) as typeof fetch;

    await expect(
      tryClient("/api/slow", { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(ClientTimeoutError);
    expect(requestSignal?.aborted).toBe(true);
  });

  test("keeps an explicit caller cancellation distinct from a deadline", async () => {
    const controller = new AbortController();
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          { once: true },
        );
      })) as typeof fetch;

    const pending = client("/api/cancellable", {
      signal: controller.signal,
      timeoutMs: 100,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("does not add a wrapper signal when no deadline is requested", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;

    await client("/api/fast", { signal: controller.signal });

    expect(requestSignal).toBe(controller.signal);
  });

  test("rejects a successful response that is missing its declared envelope", async () => {
    globalThis.fetch = (async () =>
      Response.json({ other: "value" })) as unknown as typeof fetch;

    await expect(
      client("/api/malformed", "payload", {
        fallback: "Не удалось прочитать ответ.",
      }),
    ).rejects.toThrow("Не удалось прочитать ответ.");
  });

  test("turns an invalid JSON success body into the endpoint fallback", async () => {
    globalThis.fetch = (async () =>
      new Response("not-json", {
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;

    await expect(
      client("/api/malformed", "payload", {
        fallback: "Не удалось прочитать ответ.",
      }),
    ).rejects.toThrow("Не удалось прочитать ответ.");
  });
});
