import { afterEach, describe, expect, test } from "bun:test";
import { callTool, listTools } from "../src/plugins/google-docs-rest";

const CONNECTION = {
  url: "https://docs.googleapis.com/v1",
  token: "person-oauth-token",
};

type RecordedCall = {
  url: string;
  method: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  body: unknown;
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function queueFetch(
  ...answers: Array<{
    body?: unknown;
    rawBody?: string;
    status?: number;
    contentLength?: number;
    throws?: boolean;
  }>
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? init.body : null;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization") ?? null,
      redirect: init?.redirect,
      body: rawBody === null ? null : JSON.parse(rawBody),
    });
    const answer = answers.shift();
    if (!answer) throw new Error("Unexpected fetch");
    if (answer.throws) throw new Error("socket closed");
    return new Response(answer.rawBody ?? JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(answer.contentLength === undefined
          ? {}
          : { "content-length": String(answer.contentLength) }),
      },
    });
  }) as typeof fetch;
  return calls;
}

function documentFixture(overrides: Record<string, unknown> = {}) {
  return {
    documentId: "doc_123",
    title: "Launch plan",
    revisionId: "opaque-revision-must-not-leak",
    tabs: [
      {
        tabProperties: { tabId: "tab_main", title: "Main" },
        documentTab: {
          body: {
            content: [
              {
                startIndex: 1,
                endIndex: 10,
                paragraph: {
                  paragraphStyle: { namedStyleType: "HEADING_1" },
                  elements: [
                    {
                      startIndex: 1,
                      endIndex: 10,
                      textRun: { content: "Overview\n" },
                    },
                  ],
                },
              },
              {
                startIndex: 10,
                endIndex: 20,
                paragraph: {
                  bullet: { listId: "list_1" },
                  elements: [
                    {
                      startIndex: 10,
                      endIndex: 20,
                      textRun: { content: "Ship well.\n" },
                    },
                  ],
                },
              },
              {
                startIndex: 20,
                endIndex: 35,
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        {
                          content: [
                            {
                              startIndex: 21,
                              endIndex: 26,
                              paragraph: {
                                elements: [
                                  {
                                    startIndex: 21,
                                    endIndex: 26,
                                    textRun: { content: "Owner" },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                        {
                          content: [
                            {
                              startIndex: 27,
                              endIndex: 32,
                              paragraph: {
                                elements: [
                                  {
                                    startIndex: 27,
                                    endIndex: 32,
                                    textRun: { content: "Alice" },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
              {
                startIndex: 35,
                endIndex: 41,
                paragraph: {
                  elements: [
                    {
                      startIndex: 35,
                      endIndex: 41,
                      textRun: { content: "world\n" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
    internalMetadata: { accessToken: "must-not-leak" },
    ...overrides,
  };
}

describe("Google Docs tool contract", () => {
  test("advertises only implemented tools with policy-clear read/write names", async () => {
    const tools = await listTools(CONNECTION);
    expect(tools.map((tool) => tool.name)).toEqual([
      "read_google_document",
      "read_google_document_edit_map",
      "create_google_doc",
      "append_google_doc",
      "replace_google_doc_range",
    ]);

    queueFetch({ body: documentFixture() });
    for (const tool of tools) {
      const result = await callTool(CONNECTION, tool.name, {});
      expect(result.text).not.toContain("is not a tool this connector");
    }
  });

  test("does not need a person's OAuth token just to list static tools", async () => {
    expect(await listTools({ url: CONNECTION.url })).toHaveLength(5);
  });
});

describe("structured reads", () => {
  test("reads all tabs with the person's bearer token and returns bounded useful structure", async () => {
    const calls = queueFetch({ body: documentFixture() });
    const result = await callTool(CONNECTION, "read_google_document", {
      documentId: "doc_123",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("# Launch plan");
    expect(result.text).toContain("## Tab: Main");
    expect(result.text).toContain('tabId: "tab_main"');
    expect(result.text).toContain("# Overview");
    expect(result.text).toContain("- Ship well.");
    expect(result.text).toContain("Table 1");
    expect(result.text).toContain("Column 1: Owner");
    expect(result.text).toContain("Column 2: Alice");
    expect(result.text).toContain(
      "https://docs.google.com/document/d/doc_123/edit",
    );
    expect(result.text).not.toContain("opaque-revision-must-not-leak");
    expect(result.text).not.toContain("must-not-leak");

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(
      "https://docs.googleapis.com/v1/documents/doc_123",
    );
    expect(url.searchParams.get("includeTabsContent")).toBe("true");
    expect(url.searchParams.has("suggestionsViewMode")).toBe(false);
    expect(calls[0].authorization).toBe("Bearer person-oauth-token");
    expect(calls[0].redirect).toBe("manual");
  });

  test("reads a bounded paged edit map for one exact tab", async () => {
    queueFetch({ body: documentFixture() });
    const result = await callTool(CONNECTION, "read_google_document_edit_map", {
      documentId: "doc_123",
      tabId: "tab_main",
      startIndex: 35,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('tabId: "tab_main"');
    expect(result.text).toContain("startIndex: 35");
    expect(result.text).toContain("nextStartIndex: none");
    expect(result.text).toContain('UTF-16 [35, 40): "world"');
    expect(result.text).not.toContain("opaque-revision-must-not-leak");
  });

  test("continues a large edit map from the returned UTF-16 index", async () => {
    const hugeText = "\\".repeat(16_000);
    const fixture = documentFixture({
      tabs: [
        {
          tabProperties: { tabId: "tab_main", title: "Main" },
          documentTab: {
            body: {
              content: [
                {
                  startIndex: 1,
                  endIndex: 16_001,
                  paragraph: {
                    elements: [
                      {
                        startIndex: 1,
                        endIndex: 16_001,
                        textRun: { content: hugeText },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    });
    queueFetch({ body: fixture }, { body: fixture });

    const first = await callTool(CONNECTION, "read_google_document_edit_map", {
      documentId: "doc_123",
      tabId: "tab_main",
    });
    const nextStartIndex = Number(
      first.text.match(/nextStartIndex: (\d+)/)?.[1],
    );
    const renderedEnds = [
      ...first.text.matchAll(/UTF-16 \[\d+, (\d+)\):/g),
    ].map((match) => Number(match[1]));
    expect(first.truncated).toBe(false);
    expect(nextStartIndex).toBe(renderedEnds.at(-1));
    expect(nextStartIndex).toBeGreaterThan(1);
    expect(nextStartIndex).toBeLessThan(16_001);

    const second = await callTool(CONNECTION, "read_google_document_edit_map", {
      documentId: "doc_123",
      tabId: "tab_main",
      startIndex: nextStartIndex,
    });
    expect(second.isError).toBe(false);
    expect(second.truncated).toBe(false);
    expect(second.text).toContain(`UTF-16 [${nextStartIndex},`);
  });

  test("rejects an invalid Google response instead of guessing its shape", async () => {
    queueFetch({ body: { documentId: 42, title: ["wrong"] } });
    const result = await callTool(CONNECTION, "read_google_document", {
      documentId: "doc_123",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("unexpected response");
    expect(result.text).not.toContain("42");
  });

  test("caps very large document text visibly", async () => {
    const huge = "x".repeat(2_000);
    queueFetch({
      body: documentFixture({
        tabs: [
          {
            tabProperties: { tabId: "tab_main", title: "Main" },
            documentTab: {
              body: {
                content: Array.from({ length: 12 }, (_, index) => ({
                  startIndex: index * huge.length + 1,
                  endIndex: (index + 1) * huge.length + 1,
                  paragraph: {
                    elements: [
                      {
                        startIndex: index * huge.length + 1,
                        endIndex: (index + 1) * huge.length + 1,
                        textRun: { content: huge },
                      },
                    ],
                  },
                })),
              },
            },
          },
          {
            tabProperties: { tabId: "tab_late", title: "Late tab" },
            documentTab: {
              body: {
                content: [
                  {
                    startIndex: 1,
                    endIndex: 6,
                    paragraph: {
                      elements: [
                        {
                          startIndex: 1,
                          endIndex: 6,
                          textRun: { content: "Later" },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      }),
    });

    const result = await callTool(CONNECTION, "read_google_document", {
      documentId: "doc_123",
    });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(20_200);
    expect(result.text).toContain("[truncated:");
    expect(result.text).toContain('"Late tab" — tabId: "tab_late"');
  });

  test("refuses an oversized API response before parsing it", async () => {
    queueFetch({ body: {}, contentLength: 1_000_001 });
    const result = await callTool(CONNECTION, "read_google_document", {
      documentId: "doc_123",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "more data than this tool can safely process",
    );
  });
});

describe("document writes", () => {
  test("creates only a blank document with a validated title", async () => {
    const calls = queueFetch({
      body: {
        documentId: "created_1",
        title: "Quarterly plan",
        revisionId: "do-not-return",
      },
    });
    const result = await callTool(CONNECTION, "create_google_doc", {
      title: "Quarterly plan",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Quarterly plan");
    expect(result.text).toContain(
      "https://docs.google.com/document/d/created_1/edit",
    );
    expect(result.text).not.toContain("do-not-return");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { title: "Quarterly plan" },
      authorization: "Bearer person-oauth-token",
    });
    expect(new URL(calls[0].url).pathname).toBe("/v1/documents");
  });

  test("appends at the selected tab end and pins the fresh revision", async () => {
    const calls = queueFetch(
      { body: documentFixture() },
      { body: { documentId: "doc_123", replies: [] } },
    );
    const result = await callTool(CONNECTION, "append_google_doc", {
      documentId: "doc_123",
      tabId: "tab_main",
      text: "Next step.\n",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Appended 11 characters");
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("POST");
    expect(new URL(calls[1].url).pathname).toBe(
      "/v1/documents/doc_123:batchUpdate",
    );
    expect(calls[1].body).toEqual({
      requests: [
        {
          insertText: {
            location: { index: 40, tabId: "tab_main" },
            text: "Next step.\n",
          },
        },
      ],
      writeControl: { requiredRevisionId: "opaque-revision-must-not-leak" },
    });
  });

  test("an append with an unreadable success response is never safe to retry automatically", async () => {
    queueFetch(
      { body: documentFixture() },
      { rawBody: "not-json", status: 200 },
    );
    const result = await callTool(CONNECTION, "append_google_doc", {
      documentId: "doc_123",
      tabId: "tab_main",
      text: "Possibly written once.\n",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("write outcome is unknown");
    expect(result.text).toContain("Do not retry automatically");
    expect(result.text).toContain("read the document");
  });

  test("an append with a server error after dispatch is reported as ambiguous", async () => {
    queueFetch(
      { body: documentFixture() },
      { body: { error: { message: "do not echo" } }, status: 503 },
    );
    const result = await callTool(CONNECTION, "append_google_doc", {
      documentId: "doc_123",
      tabId: "tab_main",
      text: "Possibly written once.\n",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("write outcome is unknown");
    expect(result.text).not.toContain("do not echo");
  });

  test("an append with a lost connection after dispatch is reported as ambiguous", async () => {
    queueFetch({ body: documentFixture() }, { throws: true });
    const result = await callTool(CONNECTION, "append_google_doc", {
      documentId: "doc_123",
      tabId: "tab_main",
      text: "Possibly written once.\n",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("write outcome is unknown");
    expect(result.text).toContain("Do not retry automatically");
  });

  test("does not silently choose the first tab in a multi-tab document", async () => {
    const secondTab = {
      tabProperties: { tabId: "tab_other", title: "Other" },
      documentTab: { body: { content: [] } },
    };
    const fixture = documentFixture();
    queueFetch({
      body: { ...fixture, tabs: [...fixture.tabs, secondTab] },
    });
    const result = await callTool(CONNECTION, "append_google_doc", {
      documentId: "doc_123",
      text: "Do not guess",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("tabId");
  });

  test("uses the read edit map to replace an exact range and pins its revision", async () => {
    const calls = queueFetch(
      { body: documentFixture() },
      { body: documentFixture() },
      { body: { documentId: "doc_123", replies: [{}, {}] } },
    );
    const read = await callTool(CONNECTION, "read_google_document_edit_map", {
      documentId: "doc_123",
      tabId: "tab_main",
      startIndex: 35,
    });
    const editAnchor = read.text.match(/UTF-16 \[(\d+), (\d+)\): ("world")/);
    if (!editAnchor)
      throw new Error("The read result did not expose an edit anchor");
    const tabId = read.text.match(/tabId: "([^"]+)"/)?.[1];
    if (!tabId) throw new Error("The read result did not expose a tab id");

    const result = await callTool(CONNECTION, "replace_google_doc_range", {
      documentId: "doc_123",
      tabId,
      startIndex: Number(editAnchor[1]),
      endIndex: Number(editAnchor[2]),
      expectedText: JSON.parse(editAnchor[3]),
      replacementText: "team",
      confirmReplace: true,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Replaced 5 characters with 4 characters");
    expect(calls).toHaveLength(3);
    expect(calls[2].body).toEqual({
      requests: [
        {
          deleteContentRange: {
            range: {
              startIndex: 35,
              endIndex: 40,
              tabId: "tab_main",
            },
          },
        },
        {
          insertText: {
            location: { index: 35, tabId: "tab_main" },
            text: "team",
          },
        },
      ],
      writeControl: { requiredRevisionId: "opaque-revision-must-not-leak" },
    });
  });

  test("refuses destructive replacement unless it is explicit and still matches", async () => {
    const noConfirmCalls = queueFetch({ body: documentFixture() });
    const noConfirm = await callTool(CONNECTION, "replace_google_doc_range", {
      documentId: "doc_123",
      tabId: "tab_main",
      startIndex: 35,
      endIndex: 40,
      expectedText: "world",
      replacementText: "team",
    });
    expect(noConfirm.isError).toBe(true);
    expect(noConfirmCalls).toHaveLength(0);

    const mismatchCalls = queueFetch({ body: documentFixture() });
    const mismatch = await callTool(CONNECTION, "replace_google_doc_range", {
      documentId: "doc_123",
      tabId: "tab_main",
      startIndex: 35,
      endIndex: 40,
      expectedText: "earth",
      replacementText: "team",
      confirmReplace: true,
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.text).toContain("does not match expectedText");
    expect(mismatchCalls).toHaveLength(1);
  });

  test("requires a second explicit confirmation for deletion", async () => {
    const calls = queueFetch({ body: documentFixture() });
    const result = await callTool(CONNECTION, "replace_google_doc_range", {
      documentId: "doc_123",
      tabId: "tab_main",
      startIndex: 35,
      endIndex: 40,
      expectedText: "world",
      replacementText: "",
      confirmReplace: true,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("confirmDelete");
    expect(calls).toHaveLength(0);
  });

  test("a confirmed deletion sends only the bounded delete request", async () => {
    const calls = queueFetch(
      { body: documentFixture() },
      { body: { documentId: "doc_123", replies: [{}] } },
    );
    const result = await callTool(CONNECTION, "replace_google_doc_range", {
      documentId: "doc_123",
      tabId: "tab_main",
      startIndex: 35,
      endIndex: 40,
      expectedText: "world",
      replacementText: "",
      confirmReplace: true,
      confirmDelete: true,
    });

    expect(result.isError).toBe(false);
    expect(calls[1].body).toEqual({
      requests: [
        {
          deleteContentRange: {
            range: {
              startIndex: 35,
              endIndex: 40,
              tabId: "tab_main",
            },
          },
        },
      ],
      writeControl: { requiredRevisionId: "opaque-revision-must-not-leak" },
    });
  });

  test("rejects wide ranges before reading or writing anything", async () => {
    const calls = queueFetch({ body: documentFixture() });
    const result = await callTool(CONNECTION, "replace_google_doc_range", {
      documentId: "doc_123",
      startIndex: 1,
      endIndex: 5_000,
      expectedText: "x",
      replacementText: "y",
      confirmReplace: true,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("2,000");
    expect(calls).toHaveLength(0);
  });
});

describe("safe failures", () => {
  test("refuses a call without a person's bearer token before the network", async () => {
    const calls = queueFetch({ body: documentFixture() });
    const result = await callTool(
      { url: CONNECTION.url },
      "read_google_document",
      {
        documentId: "doc_123",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Connect your Google account");
    expect(calls).toHaveLength(0);
  });

  test("does not echo Google's raw error body or identifiers", async () => {
    queueFetch({
      status: 403,
      body: {
        error: {
          message:
            "Project secret-project-123 rejected token ya29.raw-secret-token",
        },
      },
    });
    const result = await callTool(CONNECTION, "read_google_document", {
      documentId: "doc_123",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("permission");
    expect(result.text).toContain("403");
    expect(result.text).not.toContain("secret-project-123");
    expect(result.text).not.toContain("ya29.raw-secret-token");
  });
});
