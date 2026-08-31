import { afterEach, describe, expect, test } from "bun:test";
import { catalogueEntry } from "../src/plugins/catalogue";
import { callTool, listTools } from "../src/plugins/google-drive-rest";
import { callTool as workspaceCallTool } from "../src/plugins/google-workspace-rest";
import { transportFor } from "../src/plugins/transport";

/**
 * The Drive REST adapter, asserted without Google.
 *
 * `fetch` is replaced rather than a server started, because what is under test is the translation:
 * which URL a tool becomes, what a refusal reads as, and that an empty listing says so in words.
 * None of that needs a network, and all of it is what breaks when Drive's shapes are misremembered.
 */

const connection = {
  url: "https://www.googleapis.com/drive/v3",
  token: "test-token",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records what was requested and answers with a fixed body. */
function stubFetch(
  body: unknown,
  init: { status?: number; text?: string; contentLength?: number } = {},
) {
  const calls: {
    url: string;
    authorization: string | null;
    redirect: RequestRedirect | undefined;
    signal: AbortSignal | null;
  }[] = [];
  globalThis.fetch = (async (input: string | URL, options?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(options?.headers).get("authorization") ?? null,
      redirect: options?.redirect,
      signal: options?.signal ?? null,
    });
    const payload = init.text ?? JSON.stringify(body);
    return new Response(payload, {
      status: init.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(init.contentLength === undefined
          ? {}
          : { "content-length": String(init.contentLength) }),
      },
    });
  }) as typeof fetch;
  return calls;
}

/** Answers consecutive Drive calls with different bodies. */
function stubFetchSequence(
  responses: { body: unknown; contentType?: string }[],
) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return new Response(
      typeof next.body === "string" ? next.body : JSON.stringify(next.body),
      { headers: { "content-type": next.contentType ?? "application/json" } },
    );
  }) as typeof fetch;
  return calls;
}

describe("the adapter is the transport the catalogue asks for", () => {
  test("the Drive entry resolves to this adapter, not to MCP", async () => {
    const entry = catalogueEntry("google-drive");
    expect(entry?.transport).toBe("google-workspace-rest");
    // The unified transport keeps this adapter behind the same stable catalogue key.
    expect(transportFor(entry).callTool).toBe(workspaceCallTool);
  });

  test("a server with no catalogue entry falls back to MCP", () => {
    // A custom server an administrator added by URL is somebody else's MCP endpoint by definition.
    expect(transportFor(null).callTool).not.toBe(callTool);
  });

  test("every advertised tool is one the dispatcher handles", async () => {
    const tools = await listTools(connection);
    stubFetch({ files: [] });
    for (const tool of tools) {
      // Called with no arguments on purpose. A handled tool complains about a missing argument or
      // answers; an unhandled one says it is not implemented, which is the failure being excluded.
      const result = await callTool(connection, tool.name, {});
      expect(result.text).not.toContain("is not a tool this connector");
    }
  });

  test("advertises only bounded, schema-described capabilities", async () => {
    const tools = await listTools(connection);
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_files",
      "list_recent_files",
      "list_folder",
      "get_file_metadata",
      "read_file_content",
      "export_file",
      "import_google_drive_file_to_chat",
      "upload_attachment_to_google_drive",
      "create_google_drive_folder",
      "move_google_drive_file",
    ]);

    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const search = tools.find((tool) => tool.name === "search_files");
    expect(search?.inputSchema).toMatchObject({
      anyOf: [
        { required: ["query"] },
        { required: ["keywords"] },
        { required: ["name"] },
        { required: ["mimeType"] },
        { required: ["modifiedAfter"] },
        { required: ["modifiedBefore"] },
        { required: ["folderId"] },
      ],
    });
  });
});

describe("a search becomes the right Drive request", () => {
  test("the query is sent as a Drive q clause, with the caller's token", async () => {
    const calls = stubFetch({ files: [] });
    await callTool(connection, "search_files", { query: "roadmap" });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/drive/v3/files",
    );
    expect(url.searchParams.get("q")).toBe(
      "(name contains 'roadmap' or fullText contains 'roadmap') and trashed = false",
    );
    expect(calls[0].authorization).toBe("Bearer test-token");
    expect(calls[0].redirect).toBe("manual");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  /*
   * THE INJECTION CASE. Drive's `q` syntax delimits with single quotes, so an apostrophe in a search
   * term would close the clause early — turning a search for somebody's file into a different query
   * than the one asked for, or a syntax error. Escaped, a term is only ever a term.
   */
  test("an apostrophe in the query cannot break out of the clause", async () => {
    const calls = stubFetch({ files: [] });
    await callTool(connection, "search_files", { query: "don't ship" });

    const q = new URL(calls[0].url).searchParams.get("q");
    expect(q).toBe(
      "(name contains 'don\\'t ship' or fullText contains 'don\\'t ship') and trashed = false",
    );
  });

  test("recent files are ordered by Drive rather than filtered", async () => {
    const calls = stubFetch({ files: [] });
    await callTool(connection, "list_recent_files", {});

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect(url.searchParams.get("q")).toBe("trashed = false");
  });

  test("a search with nothing to search for is refused before the network", async () => {
    const calls = stubFetch({ files: [] });
    const result = await callTool(connection, "search_files", {});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("scopes name, keywords, type, time and folder as independent clauses", async () => {
    const calls = stubFetch({ files: [] });
    await callTool(connection, "search_files", {
      name: "Q3 plan",
      keywords: "launch notes",
      mimeType: "application/vnd.google-apps.document",
      modifiedAfter: "2026-01-01T00:00:00Z",
      modifiedBefore: "2026-08-01T00:00:00+00:00",
      folderId: "folder_123-abc",
    });

    expect(new URL(calls[0].url).searchParams.get("q")).toBe(
      "name contains 'Q3 plan' and fullText contains 'launch notes' and mimeType = 'application/vnd.google-apps.document' and modifiedTime > '2026-01-01T00:00:00Z' and modifiedTime < '2026-08-01T00:00:00+00:00' and 'folder_123-abc' in parents and trashed = false",
    );
  });

  test("rejects oversized and malformed filters before the network", async () => {
    const calls = stubFetch({ files: [] });
    const tooLong = await callTool(connection, "search_files", {
      keywords: "x".repeat(201),
    });
    const badDate = await callTool(connection, "search_files", {
      modifiedAfter: "yesterday",
    });
    const invertedDates = await callTool(connection, "search_files", {
      modifiedAfter: "2026-08-01T00:00:00Z",
      modifiedBefore: "2026-01-01T00:00:00Z",
    });
    const badFolder = await callTool(connection, "search_files", {
      folderId: "folder' or trashed = true",
    });

    expect(tooLong.isError).toBe(true);
    expect(badDate.isError).toBe(true);
    expect(invertedDates.isError).toBe(true);
    expect(badFolder.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("listing one folder", () => {
  test("uses parent membership and excludes trashed children", async () => {
    const calls = stubFetch({ files: [] });
    await callTool(connection, "list_folder", { folderId: "folder-123" });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/drive/v3/files");
    expect(url.searchParams.get("q")).toBe(
      "'folder-123' in parents and trashed = false",
    );
    expect(url.searchParams.get("orderBy")).toBe("name_natural");
  });

  test("requires a canonical Drive id", async () => {
    const calls = stubFetch({ files: [] });
    const result = await callTool(connection, "list_folder", {
      folderId: "../../token",
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("what a model is told", () => {
  test("a match is named, with the id it needs to read it", async () => {
    stubFetch({
      files: [
        {
          id: "abc123",
          name: "Roadmap",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-08-21T10:00:00Z",
          webViewLink: "https://docs.google.com/document/d/abc123",
        },
      ],
    });

    const result = await callTool(connection, "search_files", {
      query: "roadmap",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Roadmap");
    // Every other tool here takes an id, so a result without one is a dead end.
    expect(result.text).toContain("abc123");
    expect(result.text).toContain("https://docs.google.com/document/d/abc123");
  });

  /*
   * The empty case, stated in words rather than returned as an empty string. An empty result reads to
   * a model as "the tool had nothing to say" and gets filled in from memory, which for a knowledge
   * connector is the exact failure the whole lane exists to prevent.
   */
  test("nothing found says so, and is not an error", async () => {
    stubFetch({ files: [] });
    const result = await callTool(connection, "search_files", {
      query: "nothing matches this",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Nothing was found");
  });

  test("a Google refusal is useful but never exposes its raw body", async () => {
    stubFetch(
      {},
      {
        status: 403,
        text: JSON.stringify({
          error: {
            message:
              "Google Drive API denied token ya29.secret and document contents",
          },
        }),
      },
    );

    const result = await callTool(connection, "search_files", { query: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("denied access");
    expect(result.text).toContain("permissions");
    expect(result.text).not.toContain("ya29.secret");
    expect(result.text).not.toContain("document contents");
  });

  test("a network exception does not echo an unsafe error message", async () => {
    globalThis.fetch = (async () => {
      throw new Error("request failed with token ya29.network-secret");
    }) as typeof fetch;

    const result = await callTool(connection, "search_files", { query: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("could not be reached");
    expect(result.text).not.toContain("ya29.network-secret");
  });

  test("metadata includes creation time, parents, owner and description", async () => {
    stubFetch({
      id: "doc1",
      name: "Plan",
      mimeType: "application/vnd.google-apps.document",
      createdTime: "2026-01-01T00:00:00Z",
      modifiedTime: "2026-02-01T00:00:00Z",
      parents: ["folder1"],
      owners: [{ emailAddress: "owner@example.com" }],
      description: "Release plan",
    });

    const result = await callTool(connection, "get_file_metadata", {
      fileId: "doc1",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("created: 2026-01-01T00:00:00Z");
    expect(result.text).toContain("parent ids: folder1");
    expect(result.text).toContain("owner: owner@example.com");
    expect(result.text).toContain("description: Release plan");
  });
});

describe("reading a file asks Drive what it is first", () => {
  test("a Google Doc is exported as text, never downloaded", async () => {
    const calls = stubFetch({
      id: "doc1",
      name: "Notes",
      mimeType: "application/vnd.google-apps.document",
    });

    await callTool(connection, "read_file_content", { fileId: "doc1" });

    expect(calls).toHaveLength(2);
    // `alt=media` refuses an editor file outright, so the export path is not an optimisation.
    expect(calls[1].url).toContain("/files/doc1/export");
    expect(new URL(calls[1].url).searchParams.get("mimeType")).toBe(
      "text/plain",
    );
  });

  test("an ordinary text file is downloaded", async () => {
    const calls = stubFetch({
      id: "txt1",
      name: "notes.txt",
      mimeType: "text/plain",
    });

    await callTool(connection, "read_file_content", { fileId: "txt1" });

    expect(new URL(calls[1].url).searchParams.get("alt")).toBe("media");
    expect(calls[1].url).not.toContain("/export");
  });

  /*
   * A PDF is declined by name rather than decoded and hoped for.
   *
   * `response.text()` on binary produces thousands of replacement characters, and that goes straight
   * into a model's context: it costs the tokens of the real document, says nothing, and looks enough
   * like content that the model will try to summarise it. The assertion that matters is the second
   * one — the download is never even attempted, so the bytes never exist to be mangled.
   */
  test("a binary file is declined instead of being read as text", async () => {
    const calls = stubFetch({
      id: "pdf1",
      name: "Contract.pdf",
      mimeType: "application/pdf",
    });

    const result = await callTool(connection, "read_file_content", {
      fileId: "pdf1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("application/pdf");
    // One call: the metadata lookup. No download followed it.
    expect(calls).toHaveLength(1);
  });

  test("a file id is required, and no request is made without one", async () => {
    const calls = stubFetch({});
    const result = await callTool(connection, "read_file_content", {});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("does not buffer a response declared larger than the tool limit", async () => {
    const calls = stubFetch(
      { id: "txt1", name: "notes.txt", mimeType: "text/plain" },
      { contentLength: 100_000 },
    );
    const result = await callTool(connection, "read_file_content", {
      fileId: "txt1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("too large");
    // Metadata itself was rejected before a content download could start.
    expect(calls).toHaveLength(1);
  });
});

describe("explicit text export", () => {
  test("exports a Google Sheet as bounded CSV", async () => {
    const calls = stubFetchSequence([
      {
        body: {
          id: "sheet1",
          name: "Budget",
          mimeType: "application/vnd.google-apps.spreadsheet",
        },
      },
      { body: "month,total\nJan,42", contentType: "text/csv" },
    ]);

    const result = await callTool(connection, "export_file", {
      fileId: "sheet1",
      mimeType: "text/csv",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Budget (text/csv)");
    expect(result.text).toContain("Jan,42");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]).searchParams.get("mimeType")).toBe("text/csv");
  });

  test("refuses binary and source-incompatible export formats", async () => {
    const calls = stubFetchSequence([
      {
        body: {
          id: "doc1",
          name: "Plan",
          mimeType: "application/vnd.google-apps.document",
        },
      },
      {
        body: {
          id: "doc1",
          name: "Plan",
          mimeType: "application/vnd.google-apps.document",
        },
      },
    ]);

    const binary = await callTool(connection, "export_file", {
      fileId: "doc1",
      mimeType: "application/pdf",
    });
    const incompatible = await callTool(connection, "export_file", {
      fileId: "doc1",
      mimeType: "text/csv",
    });

    expect(binary.isError).toBe(true);
    expect(binary.text).toContain("text-only");
    expect(incompatible.isError).toBe(true);
    expect(incompatible.text).toContain("cannot be exported as text/csv");
    // Binary is rejected locally; the incompatible text format stops after metadata.
    expect(calls).toHaveLength(1);
  });
});
