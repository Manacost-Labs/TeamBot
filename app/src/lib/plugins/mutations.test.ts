import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { disconnectAccountMutationOptions } from "./mutations";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("disconnect account mutation", () => {
  test("calls the actor-scoped endpoint and validates the result", async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ input: String(input), init });
      return new Response(
        JSON.stringify({ disconnected: true, vendorRevoked: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const mutation = disconnectAccountMutationOptions(new QueryClient());
    const run = mutation.mutationFn as (serverId: string) => Promise<unknown>;
    await expect(run("google drive")).resolves.toEqual({
      disconnected: true,
      vendorRevoked: false,
    });
    expect(calls[0]?.input).toBe("/api/plugins/connections/google%20drive");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  test("rejects a malformed success response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ disconnected: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const mutation = disconnectAccountMutationOptions(new QueryClient());
    const run = mutation.mutationFn as (serverId: string) => Promise<unknown>;
    await expect(run("google-drive")).rejects.toThrow(
      "неполный результат отключения",
    );
  });
});
