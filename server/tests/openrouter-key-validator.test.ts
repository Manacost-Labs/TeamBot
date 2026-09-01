import { describe, expect, test } from "bun:test";
import {
  createOpenRouterKeyValidator,
  type OpenRouterKeyValidationFailureCode,
} from "../src/ai-connections/openrouter";

const endpoint = "https://openrouter.ai/api/v1/key";
const contentType = { "content-type": "application/json; charset=utf-8" };

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      usage: 25.5,
      limit: 100,
      limit_remaining: 74.5,
      is_free_tier: false,
      ...overrides,
    },
  };
}

describe("OpenRouter current-key validator", () => {
  test("makes one fixed authenticated request and projects only approved limits", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const validator = createOpenRouterKeyValidator({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return Response.json(
          validPayload({
            label: "PRIVATE KEY LABEL",
            hash: "PRIVATE KEY HASH",
            creator_user_id: "PRIVATE CREATOR",
            rate_limit: { requests: 999, interval: "deprecated" },
            url: "https://metadata.invalid/private",
          }),
          { headers: contentType },
        );
      },
    });

    const result = await validator.validate("visible-ascii-no-prefix_~", {
      url: "https://evil.invalid/caller-selected",
      headers: { authorization: "Bearer attacker-selected" },
    } as never);

    expect(result).toEqual({
      ok: true,
      metadata: {
        usageUsd: 25.5,
        limitUsd: 100,
        limitRemainingUsd: 74.5,
        isFreeTier: false,
      },
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe(endpoint);
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: "Bearer visible-ascii-no-prefix_~",
      },
    });
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    const outward = JSON.stringify(result);
    expect(outward).not.toContain("PRIVATE");
    expect(outward).not.toContain("metadata.invalid");
    expect(outward).not.toContain("rate_limit");
  });

  test("preserves valid zero, false and null values", async () => {
    const validator = createOpenRouterKeyValidator({
      fetchImpl: async () =>
        Response.json(
          validPayload({
            usage: 0,
            limit: null,
            limit_remaining: null,
            is_free_tier: false,
          }),
          { headers: contentType },
        ),
    });

    await expect(validator.validate("x")).resolves.toEqual({
      ok: true,
      metadata: {
        usageUsd: 0,
        limitUsd: null,
        limitRemainingUsd: null,
        isFreeTier: false,
      },
    });
  });

  test("rejects malformed keys locally without trimming or assuming a prefix", async () => {
    let requests = 0;
    const validator = createOpenRouterKeyValidator({
      fetchImpl: async () => {
        requests += 1;
        return Response.json(validPayload(), { headers: contentType });
      },
    });
    const malformed: unknown[] = [
      null,
      "",
      " ",
      "leading-space ",
      " trailing-space",
      "line\nbreak",
      "tab\tinside",
      "nul\0inside",
      "é",
      "x".repeat(4_097),
    ];

    for (const key of malformed) {
      await expect(validator.validate(key as string)).resolves.toEqual({
        ok: false,
        code: "invalid_key",
      });
    }
    expect(requests).toBe(0);

    await expect(validator.validate("A")).resolves.toMatchObject({ ok: true });
    await expect(validator.validate("~".repeat(4_096))).resolves.toMatchObject({
      ok: true,
    });
    expect(requests).toBe(2);
  });

  test("maps HTTP failures without reading their body or copying hostile headers", async () => {
    const cases: Array<[number, OpenRouterKeyValidationFailureCode]> = [
      [401, "invalid_key"],
      [403, "forbidden"],
      [429, "rate_limited"],
      [408, "provider_unavailable"],
      [500, "provider_unavailable"],
      [599, "provider_unavailable"],
      [400, "provider_refused"],
      [404, "provider_refused"],
    ];

    for (const [status, code] of cases) {
      let reads = 0;
      let cancellations = 0;
      const body = {
        getReader() {
          reads += 1;
          throw new Error("PRIVATE VENDOR BODY");
        },
        cancel() {
          cancellations += 1;
          return Promise.resolve();
        },
      } as unknown as ReadableStream<Uint8Array>;
      const validator = createOpenRouterKeyValidator({
        fetchImpl: async () =>
          ({
            body,
            status,
            headers: new Headers({
              location: "https://evil.invalid/key-in-location",
              link: "<https://evil.invalid/key-in-link>",
              "set-cookie": "private-cookie=private-value",
            }),
          }) as Response,
      });

      const result = await validator.validate("private-request-key");
      expect(result).toEqual({ ok: false, code });
      expect(reads).toBe(0);
      expect(cancellations).toBe(1);
      const outward = JSON.stringify(result);
      expect(outward).not.toContain("private-request-key");
      expect(outward).not.toContain("evil.invalid");
      expect(outward).not.toContain("private-cookie");
    }
  });

  test("refuses same-origin and cross-origin redirects without following either", async () => {
    for (const location of [
      "https://openrouter.ai/api/v1/key-again",
      "https://evil.invalid/steal",
    ]) {
      let calls = 0;
      let reads = 0;
      const validator = createOpenRouterKeyValidator({
        fetchImpl: async (_input, init) => {
          calls += 1;
          expect(init?.redirect).toBe("manual");
          return {
            status: 302,
            body: {
              getReader() {
                reads += 1;
                throw new Error("redirect body must not be read");
              },
              cancel: () => Promise.resolve(),
            },
            headers: new Headers({ location }),
          } as unknown as Response;
        },
      });

      const result = await validator.validate("redirect-test-key");
      expect(result).toEqual({ ok: false, code: "provider_refused" });
      expect(calls).toBe(1);
      expect(reads).toBe(0);
      expect(JSON.stringify(result)).not.toContain(location);
    }
  });

  test("turns network errors and aborts into one stable safe result", async () => {
    const secret = "key-that-must-not-enter-errors";
    const thrown = createOpenRouterKeyValidator({
      fetchImpl: async () => {
        throw new Error(`socket failed while using ${secret}`);
      },
    });
    const thrownResult = await thrown.validate(secret);
    expect(thrownResult).toEqual({
      ok: false,
      code: "provider_unavailable",
    });
    expect(JSON.stringify(thrownResult)).not.toContain(secret);
    expect(String(thrownResult)).not.toContain("socket failed");

    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error(`caller cancelled ${secret}`));
    const aborted = createOpenRouterKeyValidator({
      fetchImpl: async (_input, init) => {
        calls += 1;
        init?.signal?.throwIfAborted();
        return Response.json(validPayload(), { headers: contentType });
      },
    });
    const abortedResult = await aborted.validate(secret, {
      signal: controller.signal,
    });
    expect(abortedResult).toEqual({
      ok: false,
      code: "provider_unavailable",
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(abortedResult)).not.toContain(secret);
  });

  test("enforces its deadline while fetch is pending", async () => {
    let calls = 0;
    const validator = createOpenRouterKeyValidator({
      timeoutMs: 20,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(signal?.reason);
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });

    await expect(validator.validate("timeout-key")).resolves.toEqual({
      ok: false,
      code: "provider_unavailable",
    });
    expect(calls).toBe(1);
  });

  test("rejects a response that arrives after the deadline even when fetch ignored abort", async () => {
    let cancellations = 0;
    const validator = createOpenRouterKeyValidator({
      timeoutMs: 20,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancellations += 1;
            },
          }),
          { status: 401 },
        );
      },
    });

    await expect(validator.validate("late-response-key")).resolves.toEqual({
      ok: false,
      code: "provider_unavailable",
    });
    expect(cancellations).toBe(1);
  });

  test("cancels a response body that stalls at the deadline", async () => {
    let cancellations = 0;
    const validator = createOpenRouterKeyValidator({
      timeoutMs: 20,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              cancellations += 1;
            },
          }),
          { headers: contentType },
        ),
    });

    await expect(validator.validate("body-timeout-key")).resolves.toEqual({
      ok: false,
      code: "provider_unavailable",
    });
    expect(cancellations).toBe(1);
  });

  test("rejects a declared oversized body without reading it and cancels the stream", async () => {
    let reads = 0;
    let cancellations = 0;
    const body = {
      getReader() {
        reads += 1;
        throw new Error("oversized body must not be read");
      },
      cancel() {
        cancellations += 1;
        return Promise.resolve();
      },
    } as unknown as ReadableStream<Uint8Array>;
    const validator = createOpenRouterKeyValidator({
      fetchImpl: async () =>
        ({
          status: 200,
          body,
          headers: new Headers({
            ...contentType,
            "content-length": String(16 * 1024 + 1),
          }),
        }) as Response,
    });

    await expect(validator.validate("declared-size-key")).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
    expect(reads).toBe(0);
    expect(cancellations).toBe(1);
  });

  test("bounds chunked responses and cancels after the first excessive byte", async () => {
    let cancellations = 0;
    const validator = createOpenRouterKeyValidator({
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(10 * 1024));
              controller.enqueue(new Uint8Array(7 * 1024));
            },
            cancel() {
              cancellations += 1;
            },
          }),
          { headers: contentType },
        ),
    });

    await expect(validator.validate("chunked-size-key")).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
    expect(cancellations).toBe(1);
  });

  test("requires JSON content type, fatal UTF-8 and the exact selected field types", async () => {
    const cases: Response[] = [
      new Response(JSON.stringify(validPayload())),
      new Response(JSON.stringify(validPayload()), {
        headers: { "content-type": "text/json" },
      }),
      new Response(new Uint8Array([0xc3, 0x28]), { headers: contentType }),
      new Response("{not-json", { headers: contentType }),
      Response.json({}, { headers: contentType }),
      Response.json({ data: null }, { headers: contentType }),
      Response.json(validPayload({ usage: undefined }), {
        headers: contentType,
      }),
      Response.json(validPayload({ limit: undefined }), {
        headers: contentType,
      }),
      Response.json(validPayload({ limit_remaining: undefined }), {
        headers: contentType,
      }),
      Response.json(validPayload({ is_free_tier: undefined }), {
        headers: contentType,
      }),
      Response.json(validPayload({ usage: -1 }), { headers: contentType }),
      Response.json(validPayload({ usage: "0" }), { headers: contentType }),
      Response.json(validPayload({ limit: -1 }), { headers: contentType }),
      Response.json(validPayload({ limit: "1" }), { headers: contentType }),
      Response.json(validPayload({ limit_remaining: -1 }), {
        headers: contentType,
      }),
      Response.json(validPayload({ limit_remaining: "1" }), {
        headers: contentType,
      }),
      Response.json(validPayload({ is_free_tier: 0 }), {
        headers: contentType,
      }),
    ];

    for (const response of cases) {
      const validator = createOpenRouterKeyValidator({
        fetchImpl: async () => response,
      });
      await expect(validator.validate("schema-test-key")).resolves.toEqual({
        ok: false,
        code: "invalid_response",
      });
    }
  });

  test("contains malformed injected response exceptions as a safe invalid response", async () => {
    const secret = "malformed-response-secret";
    const validator = createOpenRouterKeyValidator({
      fetchImpl: async () =>
        ({
          status: 200,
          headers: new Headers(contentType),
          body: {
            getReader() {
              throw new Error(`malformed body exposed ${secret}`);
            },
            cancel: () => Promise.resolve(),
          },
        }) as unknown as Response,
    });

    const result = await validator.validate(secret);
    expect(result).toEqual({ ok: false, code: "invalid_response" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
