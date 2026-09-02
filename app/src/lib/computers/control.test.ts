import { afterEach, describe, expect, test } from "bun:test";
import { readControl } from "./control";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("computer control transport", () => {
  test("fails closed when the control service cannot be reached", async () => {
    globalThis.fetch = (async () => {
      throw new Error("service unavailable");
    }) as unknown as typeof fetch;

    await expect(readControl("bot-1")).resolves.toBeNull();
  });

  test("uses a bounded request and returns the server state", async () => {
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal;
      return Response.json({
        holder: "bot",
        since: "2026-09-02T00:00:00.000Z",
        requested: false,
      });
    }) as typeof fetch;

    await expect(readControl("bot-1")).resolves.toEqual({
      holder: "bot",
      since: "2026-09-02T00:00:00.000Z",
      requested: false,
    });
    expect(requestSignal).toBeDefined();
  });
});
