import { afterEach, describe, expect, test } from "bun:test";
import { catalogueEntry } from "../src/plugins/catalogue";
import { callTool, listTools } from "../src/plugins/google-workspace-rest";
import { transportFor } from "../src/plugins/transport";

const connection = {
  url: "https://stored-row.example.invalid/ignored",
  token: "person-token",
  actorId: "person-1",
  botId: "bot-1",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the unified Google Workspace transport", () => {
  test("is selected by the stable google-drive catalogue key", () => {
    const entry = catalogueEntry("google-drive");
    expect(entry?.transport).toBe("google-workspace-rest");
    expect(transportFor(entry).callTool).toBe(callTool);
  });

  test("advertises Drive, Docs and Sheets tools without a credential", async () => {
    const names = (await listTools({ url: connection.url })).map(
      (tool) => tool.name,
    );
    expect(names).toContain("search_files");
    expect(names).toContain("read_google_document");
    expect(names).toContain("read_google_sheet_range");
    expect(new Set(names).size).toBe(names.length);
  });

  test("routes a Sheets tool only to the pinned Sheets API", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify({
          spreadsheetId: "sheet_1",
          properties: { title: "Plan" },
          sheets: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await callTool(connection, "get_google_sheet_metadata", {
      spreadsheetId: "sheet_1",
    });

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).origin).toBe("https://sheets.googleapis.com");
    expect(calls[0].url).not.toContain("stored-row.example.invalid");
    expect(calls[0].authorization).toBe("Bearer person-token");
  });

  test("an unknown name reaches no Google endpoint", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch;

    const result = await callTool(connection, "invented_google_write", {});
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });
});
