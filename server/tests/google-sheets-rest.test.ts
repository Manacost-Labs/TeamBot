import { afterEach, describe, expect, test } from "bun:test";
import { callTool, listTools } from "../src/plugins/google-sheets-rest";

const connection = {
  url: "https://sheets.googleapis.com/v4/spreadsheets",
  token: "test-token",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("Google Sheets tool catalogue", () => {
  test("advertises only implemented bounded operations", async () => {
    const names = (await listTools(connection)).map((tool) => tool.name);
    expect(names).toEqual([
      "get_google_sheet_metadata",
      "list_google_sheet_tabs",
      "read_google_sheet_range",
      "create_google_spreadsheet",
      "create_google_sheet_tab",
      "append_google_sheet_rows",
      "update_google_sheet_range",
      "clear_google_sheet_range",
    ]);
  });
});

describe("bounded reads", () => {
  test("reads an exact A1 rectangle with formatted values", async () => {
    const calls = stubFetch({ range: "Research!A1:B2", values: [["A", "B"]] });
    const result = await callTool(connection, "read_google_sheet_range", {
      spreadsheetId: "sheet_1",
      range: "Research!A1:B2",
    });

    expect(result.isError).toBe(false);
    expect(decodeURIComponent(calls[0].url)).toContain(
      "/sheet_1/values/Research!A1:B2",
    );
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    expect(calls[0].init?.redirect).toBe("manual");
  });

  test("refuses whole-column and oversized ranges before the network", async () => {
    const calls = stubFetch({});
    const wholeColumn = await callTool(connection, "read_google_sheet_range", {
      spreadsheetId: "sheet_1",
      range: "Research!A:G",
    });
    const oversized = await callTool(connection, "read_google_sheet_range", {
      spreadsheetId: "sheet_1",
      range: "Research!A1:Z500",
    });

    expect(wholeColumn.isError).toBe(true);
    expect(oversized.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("rejects malformed cell objects instead of forwarding raw API metadata", async () => {
    stubFetch({
      range: "Research!A1:A1",
      values: [[{ accessToken: "must-not-leak" }]],
    });
    const result = await callTool(connection, "read_google_sheet_range", {
      spreadsheetId: "sheet_1",
      range: "Research!A1:A1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("unexpected shape");
    expect(result.text).not.toContain("must-not-leak");
  });
});

describe("validated writes", () => {
  test("append sends a rectangular row set once", async () => {
    const calls = stubFetch({
      spreadsheetId: "sheet_1",
      updates: {
        updatedRange: "Research!A2:B3",
        updatedRows: 2,
        updatedCells: 4,
      },
    });
    const result = await callTool(connection, "append_google_sheet_rows", {
      spreadsheetId: "sheet_1",
      sheetName: "Research",
      rows: [
        ["A", 1],
        ["B", 2],
      ],
    });

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    expect(decodeURIComponent(calls[0].url)).toContain(
      "/sheet_1/values/'Research'!A1:append",
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      majorDimension: "ROWS",
      values: [
        ["A", 1],
        ["B", 2],
      ],
    });
    expect(result.text).toContain("2 rows added · 4 cells");
  });

  test("append refuses ragged rows before the network", async () => {
    const calls = stubFetch({});
    const result = await callTool(connection, "append_google_sheet_rows", {
      spreadsheetId: "sheet_1",
      sheetName: "Research",
      rows: [["A", 1], ["B"]],
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("update requires exact range dimensions", async () => {
    const calls = stubFetch({});
    const result = await callTool(connection, "update_google_sheet_range", {
      spreadsheetId: "sheet_1",
      range: "Research!A1:B2",
      rows: [["only one row", "two cells"]],
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("clear requires an explicit confirmation", async () => {
    const calls = stubFetch({});
    const result = await callTool(connection, "clear_google_sheet_range", {
      spreadsheetId: "sheet_1",
      range: "Research!A2:B10",
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("an ambiguous append failure says not to retry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("socket closed");
    }) as typeof fetch;
    const result = await callTool(connection, "append_google_sheet_rows", {
      spreadsheetId: "sheet_1",
      sheetName: "Research",
      rows: [["A", 1]],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Do not retry this append automatically");
    expect(calls).toBe(1);
  });

  test("an unreadable append success response says not to retry", async () => {
    globalThis.fetch = (async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const result = await callTool(connection, "append_google_sheet_rows", {
      spreadsheetId: "sheet_1",
      sheetName: "Research",
      rows: [["A", 1]],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Do not retry this append automatically");
  });

  test("an append server error after dispatch says not to retry", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "do not echo" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const result = await callTool(connection, "append_google_sheet_rows", {
      spreadsheetId: "sheet_1",
      sheetName: "Research",
      rows: [["A", 1]],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Do not retry this append automatically");
    expect(result.text).not.toContain("do not echo");
  });
});
