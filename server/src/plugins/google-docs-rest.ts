import { z } from "zod";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/** Google Docs v1 over REST, using the connected person's OAuth bearer token. */

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_DOCUMENT_ID_CHARS = 256;
const MAX_TITLE_CHARS = 200;
const MAX_APPEND_CHARS = 10_000;
const MAX_REPLACE_RANGE = 2_000;
const MAX_REPLACEMENT_CHARS = 10_000;
const MAX_PARAGRAPHS = 200;
const MAX_TABLES = 25;
const MAX_TABLE_ROWS = 25;
const MAX_TABLE_COLUMNS = 12;
const MAX_CELL_CHARS = 500;
const MAX_PARAGRAPH_CHARS = 2_000;
const MAX_EDIT_SPANS = 30;
const MAX_EDIT_ANCHOR_CHARS = 500;

type Connection = { url: string; token?: string };

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DOCUMENT_ID_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/);
const tabIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DOCUMENT_ID_CHARS)
  .regex(/^[A-Za-z0-9_.-]+$/);

const readArgsSchema = z.object({ documentId: idSchema }).strict();
const editMapArgsSchema = z
  .object({
    documentId: idSchema,
    tabId: tabIdSchema.optional(),
    startIndex: z.number().int().min(1).max(2_000_000_000).optional(),
  })
  .strict();
const createArgsSchema = z
  .object({ title: z.string().trim().min(1).max(MAX_TITLE_CHARS) })
  .strict();
const appendArgsSchema = z
  .object({
    documentId: idSchema,
    tabId: tabIdSchema.optional(),
    text: z.string().min(1).max(MAX_APPEND_CHARS),
  })
  .strict();
const replaceArgsSchema = z
  .object({
    documentId: idSchema,
    tabId: tabIdSchema.optional(),
    startIndex: z.number().int().min(1),
    endIndex: z.number().int().min(2),
    expectedText: z.string().min(1).max(MAX_REPLACE_RANGE),
    replacementText: z.string().max(MAX_REPLACEMENT_CHARS),
    confirmReplace: z.literal(true),
    confirmDelete: z.literal(true).optional(),
  })
  .strict();

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "read_google_document",
    description:
      "Read one Google Doc as bounded structured text: title, tabs, headings, paragraphs, lists and tables. This is a read-only tool.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: {
          type: "string",
          description: "The Google Doc id from its URL.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "read_google_document_edit_map",
    description:
      "Read a bounded page of exact replaceable plain-text spans and live UTF-16 indexes from one Google Doc tab. Use nextStartIndex to continue through a large tab. This is read-only and does not expose revision ids.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: {
          type: "string",
          description: "The Google Doc id from its URL.",
        },
        tabId: {
          type: "string",
          description:
            "Target tab id from read_google_document. Required for a multi-tab document.",
        },
        startIndex: {
          type: "integer",
          minimum: 1,
          description:
            "Live UTF-16 index to start from. Omit for the first page; then use the returned nextStartIndex.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "create_google_doc",
    description:
      "Create a new blank Google Doc with a title. This is a write tool; it does not claim to create initial content in the same operation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TITLE_CHARS,
          description: "Title for the new blank document.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "append_google_doc",
    description:
      "Append bounded plain text to the end of a Google Doc tab. This is a write tool. A tabId is required when the document has multiple tabs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string", description: "The Google Doc id." },
        tabId: {
          type: "string",
          description:
            "Target tab id. Required for a multi-tab document; omit only for a single-tab document.",
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: MAX_APPEND_CHARS,
          description: "Plain text to append, up to 10,000 characters.",
        },
      },
      required: ["documentId", "text"],
    },
  },
  {
    name: "replace_google_doc_range",
    description:
      "Replace one exact narrow plain-text range in a Google Doc tab. This destructive write requires live UTF-16 indexes, the exact expectedText, and confirmReplace=true; it refuses stale or cross-structure ranges.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string", description: "The Google Doc id." },
        tabId: {
          type: "string",
          description:
            "Target tab id. Required for a multi-tab document; omit only for a single-tab document.",
        },
        startIndex: {
          type: "integer",
          minimum: 1,
          description: "Live Google Docs UTF-16 start index, inclusive.",
        },
        endIndex: {
          type: "integer",
          minimum: 2,
          description: "Live Google Docs UTF-16 end index, exclusive.",
        },
        expectedText: {
          type: "string",
          minLength: 1,
          maxLength: MAX_REPLACE_RANGE,
          description:
            "Exact current plain text in the range. The write is refused if it changed.",
        },
        replacementText: {
          type: "string",
          maxLength: MAX_REPLACEMENT_CHARS,
          description:
            "Replacement plain text. An empty value deletes the range and also requires confirmDelete=true.",
        },
        confirmReplace: {
          type: "boolean",
          const: true,
          description: "Must be true to acknowledge this destructive write.",
        },
        confirmDelete: {
          type: "boolean",
          const: true,
          description:
            "Must also be true when replacementText is empty and the operation is a deletion.",
        },
      },
      required: [
        "documentId",
        "startIndex",
        "endIndex",
        "expectedText",
        "replacementText",
        "confirmReplace",
      ],
    },
  },
]);

/** Tool discovery is static and must not force an administrator to connect a personal account. */
export const listNeedsCredential = false;

export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

type TextRun = { content: string };
type ParagraphElement = {
  startIndex?: number;
  endIndex?: number;
  textRun?: TextRun;
};
type Paragraph = {
  elements?: ParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string; nestingLevel?: number };
};
type TableCell = { content?: StructuralElement[] };
type Table = { tableRows?: Array<{ tableCells?: TableCell[] }> };
type StructuralElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  table?: Table;
  tableOfContents?: { content?: StructuralElement[] };
};
type DocumentTab = {
  tabProperties?: { tabId?: string; title?: string };
  documentTab?: { body?: { content?: StructuralElement[] } };
  childTabs?: DocumentTab[];
};
type GoogleDocument = {
  documentId: string;
  title: string;
  revisionId?: string;
  tabs?: DocumentTab[];
};

const textRunSchema = z.object({ content: z.string() });
const paragraphElementSchema = z.object({
  startIndex: z.number().int().nonnegative().optional(),
  endIndex: z.number().int().nonnegative().optional(),
  textRun: textRunSchema.optional(),
});
const paragraphSchema = z.object({
  elements: z.array(paragraphElementSchema).optional(),
  paragraphStyle: z
    .object({ namedStyleType: z.string().optional() })
    .optional(),
  bullet: z
    .object({
      listId: z.string().optional(),
      nestingLevel: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const structuralElementSchema: z.ZodType<StructuralElement> = z.lazy(() =>
  z.object({
    startIndex: z.number().int().nonnegative().optional(),
    endIndex: z.number().int().nonnegative().optional(),
    paragraph: paragraphSchema.optional(),
    table: z
      .object({
        tableRows: z
          .array(
            z.object({
              tableCells: z
                .array(
                  z.object({
                    content: z.array(structuralElementSchema).optional(),
                  }),
                )
                .optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    tableOfContents: z
      .object({ content: z.array(structuralElementSchema).optional() })
      .optional(),
  }),
);

const documentTabSchema: z.ZodType<DocumentTab> = z.lazy(() =>
  z.object({
    tabProperties: z
      .object({ tabId: z.string().optional(), title: z.string().optional() })
      .optional(),
    documentTab: z
      .object({
        body: z
          .object({ content: z.array(structuralElementSchema).optional() })
          .optional(),
      })
      .optional(),
    childTabs: z.array(documentTabSchema).optional(),
  }),
);

const documentSchema: z.ZodType<GoogleDocument> = z.object({
  documentId: z.string().min(1),
  title: z.string(),
  revisionId: z.string().min(1).optional(),
  tabs: z.array(documentTabSchema).optional(),
});
const createResponseSchema = z.object({
  documentId: z.string().min(1),
  title: z.string(),
});
const mutationResponseSchema = z.object({
  documentId: z.string().min(1),
  replies: z.array(z.unknown()).optional(),
});

type ApiResult =
  | { ok: true; payload: unknown }
  | { ok: false; message: string; ambiguous: boolean };

function requestFailure(
  message: string,
  ambiguous: boolean,
): Extract<ApiResult, { ok: false }> {
  return {
    ok: false,
    ambiguous,
    message: ambiguous
      ? `${message} The write outcome is unknown. Do not retry automatically; read the document before deciding what to do.`
      : message,
  };
}

async function boundedResponseText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}

function safeVendorFailure(status: number): string {
  if (status === 401) {
    return "Google Docs rejected this credential (401). Reconnect your Google account and try again.";
  }
  if (status === 403) {
    return "Google Docs denied permission (403). The connected account may lack access, or the required Docs scope may not be granted.";
  }
  if (status === 404) {
    return "Google Docs could not find that document (404), or the connected account cannot access it.";
  }
  if (status === 409) {
    return "Google Docs reported an edit conflict (409). Read the document again before retrying.";
  }
  if (status === 429) {
    return "Google Docs is rate-limiting requests (429). Try again shortly.";
  }
  return `Google Docs refused this request (${status}).`;
}

async function request(
  connection: Connection,
  path: string,
  options: {
    method?: "GET" | "POST";
    query?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<ApiResult> {
  if (!connection.token) {
    return requestFailure(
      "Connect your Google account before using Google Docs tools.",
      false,
    );
  }

  const isMutation = options.method === "POST";

  let url: URL;
  try {
    url = new URL(`${connection.url.replace(/\/+$/, "")}${path}`);
  } catch {
    return requestFailure("The Google Docs API URL is invalid.", false);
  }
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${connection.token}`,
        accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      // Never carry a person's bearer token to an address chosen by a redirect response.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return requestFailure(
      error instanceof Error && error.name === "TimeoutError"
        ? "Google Docs did not answer in time."
        : "Google Docs could not be reached.",
      isMutation,
    );
  }

  if (!response.ok) {
    // Never echo Google's raw body: it can carry project identifiers and credential diagnostics.
    await response.body?.cancel().catch(() => undefined);
    const ambiguous =
      isMutation &&
      (response.status === 408 ||
        response.status === 429 ||
        response.status >= 500);
    return requestFailure(safeVendorFailure(response.status), ambiguous);
  }

  try {
    const text = await boundedResponseText(response);
    if (text === null) {
      return requestFailure(
        "Google Docs returned more data than this tool can safely process.",
        isMutation,
      );
    }
    return { ok: true, payload: JSON.parse(text) as unknown };
  } catch {
    return requestFailure(
      "Google Docs returned an unexpected response.",
      isMutation,
    );
  }
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

function asResult(text: string): McpCallResult {
  const value = text.trim();
  if (value === "") {
    return {
      text: "The document contains no readable text.",
      isError: false,
      truncated: false,
    };
  }
  if (value.length <= MAX_RESULT_CHARS) {
    return { text: value, isError: false, truncated: false };
  }
  return {
    text: `${value.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the document exceeded the safe tool-result limit]`,
    isError: false,
    truncated: true,
  };
}

function parseInput<T>(
  schema: z.ZodType<T>,
  args: Record<string, unknown>,
  message: string,
): { ok: true; value: T } | { ok: false; result: McpCallResult } {
  const parsed = schema.safeParse(args);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, result: failure(message) };
}

function flattenTabs(tabs: DocumentTab[]): DocumentTab[] {
  const result: DocumentTab[] = [];
  const visit = (tab: DocumentTab) => {
    result.push(tab);
    for (const child of tab.childTabs ?? []) visit(child);
  };
  for (const tab of tabs) visit(tab);
  return result;
}

function textFromElements(elements: ParagraphElement[] | undefined): string {
  return (elements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "")
    .slice(0, MAX_PARAGRAPH_CHARS);
}

function cellText(cell: TableCell): string {
  const parts: string[] = [];
  const visit = (elements: StructuralElement[]) => {
    for (const element of elements) {
      if (element.paragraph) {
        const text = textFromElements(element.paragraph.elements).trim();
        if (text) parts.push(text);
      }
      if (element.table) {
        for (const row of element.table.tableRows ?? []) {
          for (const nestedCell of row.tableCells ?? []) {
            visit(nestedCell.content ?? []);
          }
        }
      }
    }
  };
  visit(cell.content ?? []);
  return parts.join(" / ").slice(0, MAX_CELL_CHARS);
}

function renderBody(content: StructuralElement[]): string[] {
  const lines: string[] = [];
  let paragraphs = 0;
  let tables = 0;

  const render = (elements: StructuralElement[]) => {
    for (const element of elements) {
      if (element.paragraph && paragraphs < MAX_PARAGRAPHS) {
        paragraphs += 1;
        const text = textFromElements(element.paragraph.elements).trim();
        if (text) {
          const style = element.paragraph.paragraphStyle?.namedStyleType ?? "";
          const headingMatch = /^HEADING_([1-6])$/.exec(style);
          if (headingMatch) {
            const level = Math.min(6, Number(headingMatch[1]) + 2);
            lines.push(`${"#".repeat(level)} ${text}`);
          } else if (style === "TITLE") {
            lines.push(`### ${text}`);
          } else if (style === "SUBTITLE") {
            lines.push(`_${text}_`);
          } else if (element.paragraph.bullet) {
            const nesting = Math.min(
              element.paragraph.bullet.nestingLevel ?? 0,
              6,
            );
            lines.push(`${"  ".repeat(nesting)}- ${text}`);
          } else {
            lines.push(text);
          }
        }
      }

      if (element.table && tables < MAX_TABLES) {
        tables += 1;
        lines.push(`Table ${tables}:`);
        const rows = (element.table.tableRows ?? []).slice(0, MAX_TABLE_ROWS);
        for (const [rowIndex, row] of rows.entries()) {
          const cells = (row.tableCells ?? [])
            .slice(0, MAX_TABLE_COLUMNS)
            .map(
              (cell, columnIndex) =>
                `Column ${columnIndex + 1}: ${cellText(cell) || "(empty)"}`,
            );
          lines.push(`- Row ${rowIndex + 1}: ${cells.join(" | ")}`);
        }
      }

      if (element.tableOfContents?.content) {
        render(element.tableOfContents.content);
      }
    }
  };

  render(content);
  return lines;
}

function documentLink(documentId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`;
}

function renderDocument(document: GoogleDocument): McpCallResult {
  const tabs = flattenTabs(document.tabs ?? []);
  if (tabs.length === 0) {
    return failure(
      "Google Docs returned an unexpected response without document tabs.",
    );
  }

  const lines = [
    `# ${document.title || "Untitled document"}`,
    `[Open document](${documentLink(document.documentId)})`,
    "## Tab directory",
    ...tabs.map(
      (tab, index) =>
        `- ${JSON.stringify(tab.tabProperties?.title || `Tab ${index + 1}`)} — tabId: ${JSON.stringify(tab.tabProperties?.tabId ?? "")}`,
    ),
  ];
  for (const [index, tab] of tabs.entries()) {
    lines.push(
      `## Tab: ${tab.tabProperties?.title || `Tab ${index + 1}`}`,
      ...renderBody(tab.documentTab?.body?.content ?? []),
    );
  }
  return asResult(lines.join("\n\n"));
}

async function fetchDocument(
  connection: Connection,
  documentId: string,
): Promise<
  { ok: true; document: GoogleDocument } | { ok: false; result: McpCallResult }
> {
  const response = await request(
    connection,
    `/documents/${encodeURIComponent(documentId)}`,
    {
      query: {
        includeTabsContent: "true",
      },
    },
  );
  if (!response.ok) return { ok: false, result: failure(response.message) };

  const parsed = documentSchema.safeParse(response.payload);
  if (!parsed.success) {
    return {
      ok: false,
      result: failure("Google Docs returned an unexpected response."),
    };
  }
  return { ok: true, document: parsed.data };
}

function selectTab(
  document: GoogleDocument,
  requestedTabId: string | undefined,
):
  | { ok: true; tab: DocumentTab; tabId: string }
  | { ok: false; message: string } {
  const tabs = flattenTabs(document.tabs ?? []);
  if (tabs.length === 0) {
    return { ok: false, message: "The document has no writable tab." };
  }

  if (!requestedTabId && tabs.length > 1) {
    return {
      ok: false,
      message:
        "This document has multiple tabs. Supply the exact tabId instead of choosing one implicitly.",
    };
  }
  const tab = requestedTabId
    ? tabs.find(
        (candidate) => candidate.tabProperties?.tabId === requestedTabId,
      )
    : tabs[0];
  if (!tab) {
    return { ok: false, message: "That tabId is not present in the document." };
  }
  const tabId = tab.tabProperties?.tabId;
  if (!tabId) {
    return {
      ok: false,
      message: "Google Docs returned a tab without a usable tabId.",
    };
  }
  return { ok: true, tab, tabId };
}

function lastBodyIndex(tab: DocumentTab): number | null {
  const content = tab.documentTab?.body?.content;
  if (!content) return null;
  const endIndex = content.reduce(
    (greatest, element) => Math.max(greatest, element.endIndex ?? 0),
    0,
  );
  return endIndex > 1 ? endIndex - 1 : 1;
}

type TextSpan = { start: number; end: number; text: string };
type EditAnchor = { start: number; end: number; text: string };

function boundedLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  return (trimmed || fallback).slice(0, MAX_TITLE_CHARS);
}

function renderAnchorLine(anchor: EditAnchor): string {
  return `- UTF-16 [${anchor.start}, ${anchor.end}): ${JSON.stringify(anchor.text)}`;
}

function collectTextSpans(elements: StructuralElement[]): TextSpan[] {
  const spans: TextSpan[] = [];
  const visit = (items: StructuralElement[]) => {
    for (const item of items) {
      for (const element of item.paragraph?.elements ?? []) {
        if (
          element.textRun &&
          element.startIndex !== undefined &&
          element.endIndex !== undefined &&
          element.endIndex > element.startIndex &&
          element.textRun.content.length ===
            element.endIndex - element.startIndex
        ) {
          spans.push({
            start: element.startIndex,
            end: element.endIndex,
            text: element.textRun.content,
          });
        }
      }
      for (const row of item.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) visit(cell.content ?? []);
      }
      if (item.tableOfContents?.content) visit(item.tableOfContents.content);
    }
  };
  visit(elements);
  return spans;
}

function editAnchorPage(
  elements: StructuralElement[],
  startIndex: number,
  characterBudget: number,
): { anchors: EditAnchor[]; nextStartIndex: number | null } {
  const anchors: EditAnchor[] = [];
  let renderedCharacters = 0;
  for (const span of collectTextSpans(elements)) {
    let cursor = Math.max(startIndex, span.start);
    if (cursor >= span.end) continue;

    while (cursor < span.end) {
      if (anchors.length >= MAX_EDIT_SPANS) {
        return { anchors, nextStartIndex: cursor };
      }
      const raw = span.text.slice(
        cursor - span.start,
        cursor - span.start + MAX_EDIT_ANCHOR_CHARS,
      );
      if (raw.length === 0) break;
      const anchorStart = cursor;
      const text = raw.replace(/[\r\n]+$/u, "");
      if (text.length > 0) {
        const anchor = {
          start: anchorStart,
          end: anchorStart + text.length,
          text,
        };
        const lineCharacters = renderAnchorLine(anchor).length + 2;
        if (renderedCharacters + lineCharacters > characterBudget) {
          return { anchors, nextStartIndex: anchorStart };
        }
        anchors.push(anchor);
        renderedCharacters += lineCharacters;
      }
      cursor += raw.length;
    }
  }
  return { anchors, nextStartIndex: null };
}

function renderEditMap(
  document: GoogleDocument,
  tab: DocumentTab,
  tabId: string,
  startIndex: number,
): McpCallResult {
  const title = boundedLabel(document.title, "Untitled document");
  const tabTitle = boundedLabel(tab.tabProperties?.title ?? "", "Untitled tab");
  const header = [
    `# Edit map: ${title}`,
    `[Open document](${documentLink(document.documentId)})`,
    `Tab: ${JSON.stringify(tabTitle)}`,
    `tabId: ${JSON.stringify(tabId)}`,
    `startIndex: ${startIndex}`,
  ];
  const explanatoryLine =
    "UTF-16 ranges below are live for this read and use an exclusive end index:";
  const reservedCharacters =
    header.join("\n\n").length + explanatoryLine.length + 160;
  const page = editAnchorPage(
    tab.documentTab?.body?.content ?? [],
    startIndex,
    Math.max(0, MAX_RESULT_CHARS - reservedCharacters),
  );
  const lines = [
    ...header,
    `nextStartIndex: ${page.nextStartIndex ?? "none"}`,
    explanatoryLine,
    ...(page.anchors.length > 0
      ? page.anchors.map(renderAnchorLine)
      : [
          "- No replaceable plain-text spans were found at or after this index.",
        ]),
  ];
  return asResult(lines.join("\n\n"));
}

function exactRangeText(
  tab: DocumentTab,
  startIndex: number,
  endIndex: number,
): string | null {
  const span = collectTextSpans(tab.documentTab?.body?.content ?? []).find(
    (candidate) => candidate.start <= startIndex && candidate.end >= endIndex,
  );
  if (!span) return null;
  return span.text.slice(startIndex - span.start, endIndex - span.start);
}

async function mutate(
  connection: Connection,
  documentId: string,
  body: Record<string, unknown>,
): Promise<McpCallResult | null> {
  const response = await request(
    connection,
    `/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    { method: "POST", body },
  );
  if (!response.ok) {
    return {
      ...failure(response.message),
      externalEffect: response.ambiguous ? "unknown" : "none",
    };
  }
  if (!mutationResponseSchema.safeParse(response.payload).success) {
    return {
      ...failure(
        "Google Docs returned an unexpected response after the write. The write outcome is unknown. Do not retry automatically; read the document before deciding what to do.",
      ),
      externalEffect: "unknown",
    };
  }
  return null;
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (toolName === "read_google_document") {
    const input = parseInput(
      readArgsSchema,
      args,
      "A valid documentId is required to read a Google Doc.",
    );
    if (!input.ok) return input.result;
    const found = await fetchDocument(connection, input.value.documentId);
    return found.ok ? renderDocument(found.document) : found.result;
  }

  if (toolName === "read_google_document_edit_map") {
    const input = parseInput(
      editMapArgsSchema,
      args,
      "A valid documentId, optional exact tabId, and optional positive startIndex are required to read an edit map.",
    );
    if (!input.ok) return input.result;
    const found = await fetchDocument(connection, input.value.documentId);
    if (!found.ok) return found.result;
    const selected = selectTab(found.document, input.value.tabId);
    if (!selected.ok) return failure(selected.message);
    return renderEditMap(
      found.document,
      selected.tab,
      selected.tabId,
      input.value.startIndex ?? 1,
    );
  }

  if (toolName === "create_google_doc") {
    const input = parseInput(
      createArgsSchema,
      args,
      "A non-empty title of at most 200 characters is required to create a Google Doc.",
    );
    if (!input.ok) return input.result;
    const response = await request(connection, "/documents", {
      method: "POST",
      body: { title: input.value.title },
    });
    if (!response.ok) return failure(response.message);
    const created = createResponseSchema.safeParse(response.payload);
    if (!created.success) {
      return failure(
        "Google Docs returned an unexpected response after creation. The write outcome is unknown. Do not retry automatically; check Drive before deciding whether to create it again.",
      );
    }
    return asResult(
      `Created Google Doc: [${created.data.title || "Untitled document"}](${documentLink(created.data.documentId)})\nDocument id: ${created.data.documentId}`,
    );
  }

  if (toolName === "append_google_doc") {
    const input = parseInput(
      appendArgsSchema,
      args,
      "A valid documentId and 1–10,000 characters of text are required to append.",
    );
    if (!input.ok) return { ...input.result, externalEffect: "none" };
    const found = await fetchDocument(connection, input.value.documentId);
    if (!found.ok) return { ...found.result, externalEffect: "none" };
    if (!found.document.revisionId) {
      return {
        ...failure(
          "Google Docs did not return a revision id, so a concurrency-safe append cannot be made.",
        ),
        externalEffect: "none",
      };
    }
    const selected = selectTab(found.document, input.value.tabId);
    if (!selected.ok) {
      return { ...failure(selected.message), externalEffect: "none" };
    }
    const index = lastBodyIndex(selected.tab);
    if (index === null) {
      return {
        ...failure("Google Docs returned a tab without a writable body."),
        externalEffect: "none",
      };
    }
    const writeError = await mutate(connection, input.value.documentId, {
      requests: [
        {
          insertText: {
            location: { index, tabId: selected.tabId },
            text: input.value.text,
          },
        },
      ],
      writeControl: { requiredRevisionId: found.document.revisionId },
    });
    if (writeError) return writeError;
    return {
      ...asResult(
        `Appended ${[...input.value.text].length} characters to [${found.document.title || "Untitled document"}](${documentLink(input.value.documentId)}), tab ${selected.tabId}.`,
      ),
      externalEffect: "applied",
    };
  }

  if (toolName === "replace_google_doc_range") {
    const input = parseInput(
      replaceArgsSchema,
      args,
      "A narrow range, expectedText, replacementText, and confirmReplace=true are required.",
    );
    if (!input.ok) return input.result;
    const span = input.value.endIndex - input.value.startIndex;
    if (span <= 0 || span > MAX_REPLACE_RANGE) {
      return failure(
        "The replacement range must be forward and no wider than 2,000 UTF-16 code units.",
      );
    }
    if (
      input.value.replacementText === "" &&
      input.value.confirmDelete !== true
    ) {
      return failure(
        "An empty replacement deletes the range. Set confirmDelete=true as a second explicit confirmation.",
      );
    }
    if (input.value.expectedText.includes("\n")) {
      return failure(
        "This tool only replaces a narrow range inside one paragraph; structural newline replacement is not supported.",
      );
    }

    const found = await fetchDocument(connection, input.value.documentId);
    if (!found.ok) return found.result;
    if (!found.document.revisionId) {
      return failure(
        "Google Docs did not return a revision id, so a concurrency-safe replacement cannot be made.",
      );
    }
    const selected = selectTab(found.document, input.value.tabId);
    if (!selected.ok) return failure(selected.message);
    const currentText = exactRangeText(
      selected.tab,
      input.value.startIndex,
      input.value.endIndex,
    );
    if (currentText === null) {
      return failure(
        "That range does not resolve to one current plain-text run. Read the document again and choose a narrower live range.",
      );
    }
    if (currentText !== input.value.expectedText) {
      return failure(
        "The current range does not match expectedText. Nothing was changed; read the document again before retrying.",
      );
    }

    const range = {
      startIndex: input.value.startIndex,
      endIndex: input.value.endIndex,
      tabId: selected.tabId,
    };
    const location = {
      index: input.value.startIndex,
      tabId: selected.tabId,
    };
    const requests: Record<string, unknown>[] = [
      { deleteContentRange: { range } },
    ];
    if (input.value.replacementText !== "") {
      requests.push({
        insertText: { location, text: input.value.replacementText },
      });
    }
    const writeError = await mutate(connection, input.value.documentId, {
      requests,
      writeControl: { requiredRevisionId: found.document.revisionId },
    });
    if (writeError) return writeError;
    return asResult(
      `Replaced ${[...input.value.expectedText].length} characters with ${[...input.value.replacementText].length} characters in [${found.document.title || "Untitled document"}](${documentLink(input.value.documentId)}), tab ${selected.tabId}.`,
    );
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
