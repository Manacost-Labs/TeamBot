import { afterEach, describe, expect, test } from "bun:test";
import {
  catalogueEntry,
  classifyTool,
  resolveServerUrl,
} from "../src/plugins/catalogue";
import { callTool, listTools } from "../src/plugins/oomol-connector";
import { transportFor } from "../src/plugins/transport";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const connection = {
  url: "https://stored-row.example.invalid/should-not-be-used",
  token: "api_test_key",
  actorId: "actor-1",
  botId: "bot-1",
};

describe("the hosted OOMOL Connector transport", () => {
  test("is a curated personal Connector entry with a deployment credential", () => {
    const entry = catalogueEntry("oomol-connector");

    expect(entry?.vendor).toBe("OOMOL");
    expect(entry?.auth.kind).toBe("deployment-bearer");
    expect(entry?.transport).toBe("oomol-connector");
    expect(resolveServerUrl("oomol-connector")?.url).toBe(
      "https://connector.oomol.com/v1",
    );
    expect(transportFor(entry).listNeedsCredential).toBe(true);
  });

  test("discovers action metadata with the personal bearer key", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
    }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const sent = new Request(input, init);
      const request = {
        url: sent.url,
        method: sent.method,
        authorization: sent.headers.get("authorization"),
      };
      requests.push(request);
      const url = new URL(sent.url);
      if (url.pathname.endsWith("/apps")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [{ service: "gmail" }, { service: "github" }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          data:
            url.searchParams.get("service") === "gmail"
              ? [
                  {
                    id: "gmail.search_threads",
                    description: "Search Gmail threads.",
                    inputSchema: {
                      type: "object",
                      properties: { query: { type: "string" } },
                    },
                  },
                ]
              : [
                  {
                    id: "github.get_current_user",
                    description: "Get the current GitHub user.",
                    inputSchema: { type: "object" },
                  },
                ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(listTools(connection)).resolves.toEqual([
      {
        name: "gmail.search_threads",
        description: "Search Gmail threads.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      {
        name: "github.get_current_user",
        description: "Get the current GitHub user.",
        inputSchema: { type: "object" },
      },
    ]);
    expect(requests).toEqual([
      {
        url: "https://connector.oomol.com/v1/apps",
        method: "GET",
        authorization: "Bearer api_test_key",
      },
      {
        url: "https://connector.oomol.com/v1/actions?service=gmail",
        method: "GET",
        authorization: "Bearer api_test_key",
      },
      {
        url: "https://connector.oomol.com/v1/actions?service=github",
        method: "GET",
        authorization: "Bearer api_test_key",
      },
    ]);
  });

  test("executes an action through the hosted gateway and returns bounded text", async () => {
    let request: {
      url: string;
      authorization: string | null;
      body: unknown;
    } | null = null;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const sent = new Request(input, init);
      request = {
        url: sent.url,
        authorization: sent.headers.get("authorization"),
        body: JSON.parse(await sent.text()),
      };
      return new Response(
        JSON.stringify({
          success: true,
          data: { threads: [{ id: "thread-1" }] },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      callTool(connection, "gmail.search_threads", { query: "is:unread" }),
    ).resolves.toEqual({
      text: '{"threads":[{"id":"thread-1"}]}',
      isError: false,
      truncated: false,
    });
    expect(request).toEqual({
      url: "https://connector.oomol.com/v1/actions/gmail.search_threads",
      authorization: "Bearer api_test_key",
      body: { input: { query: "is:unread" } },
    });
  });

  test("marks an oversized action result as truncated", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: true, data: { result: "x".repeat(25_000) } }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const result = await callTool(connection, "gmail.search_threads", {});
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("truncated");
  });

  test("does not expose the key when OOMOL rejects a request", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, message: "bad api_test_key" }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;

    await expect(listTools(connection)).rejects.toThrow(
      "OOMOL rejected the Connector API key",
    );
    await expect(listTools(connection)).rejects.not.toThrow("api_test_key");
  });

  test("requires a key before making a request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 500 });
    }) as typeof fetch;

    await expect(
      listTools({ ...connection, token: undefined }),
    ).rejects.toThrow("No OOMOL Connector API key is configured");
    expect(calls).toBe(0);
  });
});

test("dynamically advertised OOMOL actions are classified as writes by default", () => {
  const entry = catalogueEntry("oomol-connector");
  expect(entry).not.toBeNull();
  expect(classifyTool(entry, "gmail.search_threads", true)).toBe("write");
});
