import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RANGE_CELLS = 10_000;
const MAX_WRITE_ROWS = 500;
const MAX_WRITE_COLUMNS = 100;
const MAX_WRITE_CHARACTERS = 200_000;

type Connection = { url: string; token?: string };
type CellValue = string | number | boolean | null;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "get_google_sheet_metadata",
    description:
      "Get the title and bounded tab metadata for one Google spreadsheet without reading cell contents.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet id." },
      },
      required: ["spreadsheetId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_google_sheet_tabs",
    description:
      "List visible and hidden tabs in a Google spreadsheet, including their stable numeric sheet ids.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet id." },
      },
      required: ["spreadsheetId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_google_sheet_range",
    description:
      "Read one explicit bounded A1 range, such as 'Research'!A1:G200. Never reads a whole workbook.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet id." },
        range: {
          type: "string",
          description:
            "A bounded A1 rectangle including the exact tab name and both corners.",
        },
      },
      required: ["spreadsheetId", "range"],
      additionalProperties: false,
    },
  },
  {
    name: "create_google_spreadsheet",
    description:
      "Create a new Google spreadsheet. This is an external write and requires a write grant.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Spreadsheet title." },
        firstSheetTitle: {
          type: "string",
          description: "Optional title for the first tab.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "create_google_sheet_tab",
    description:
      "Create one tab in an existing Google spreadsheet. This is an external write.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet id." },
        sheetTitle: { type: "string", description: "New tab title." },
      },
      required: ["spreadsheetId", "sheetTitle"],
      additionalProperties: false,
    },
  },
  {
    name: "append_google_sheet_rows",
    description:
      "Append a validated rectangular set of rows to the table beginning at A1 on an exact tab. Ambiguous network failures are never retried automatically.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet id." },
        sheetName: { type: "string", description: "Exact existing tab title." },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: MAX_WRITE_ROWS,
          items: { type: "array", minItems: 1, maxItems: MAX_WRITE_COLUMNS },
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description:
            "How Google should interpret values; defaults to USER_ENTERED.",
        },
      },
      required: ["spreadsheetId", "sheetName", "rows"],
      additionalProperties: false,
    },
  },
  {
    name: "update_google_sheet_range",
    description:
      "Replace the values in one explicit bounded A1 rectangle. The row and column dimensions must exactly match the range.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet id." },
        range: { type: "string", description: "Exact bounded A1 rectangle." },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: MAX_WRITE_ROWS,
          items: { type: "array", minItems: 1, maxItems: MAX_WRITE_COLUMNS },
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description:
            "How Google should interpret values; defaults to USER_ENTERED.",
        },
      },
      required: ["spreadsheetId", "range", "rows"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_google_sheet_range",
    description:
      "Clear only the values in one explicit bounded A1 rectangle. Requires confirm=true because this is destructive.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet id." },
        range: { type: "string", description: "Exact bounded A1 rectangle." },
        confirm: {
          type: "boolean",
          const: true,
          description:
            "Must be true after the target range has been confirmed.",
        },
      },
      required: ["spreadsheetId", "range", "confirm"],
      additionalProperties: false,
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

const failure = (text: string): McpCallResult => ({
  text,
  isError: true,
  truncated: false,
});

function asResult(text: string): McpCallResult {
  const normalized = text.trim();
  if (normalized.length <= MAX_RESULT_CHARS) {
    return { text: normalized, isError: false, truncated: false };
  }
  return {
    text: `${normalized.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${normalized.length} characters]`,
    isError: false,
    truncated: true,
  };
}

const stringArg = (
  args: Record<string, unknown>,
  key: string,
): string | null => {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const validId = (value: string | null): value is string =>
  value !== null && /^[A-Za-z0-9_-]{1,256}$/.test(value);

function safeTitle(value: string | null, max: number): string | null {
  if (!value || value.length > max || hasControlCharacter(value)) {
    return null;
  }
  return value;
}

function safeSheetTitle(value: string | null): string | null {
  const title = safeTitle(value, 100);
  const forbidden = ["\\", "/", "?", "*", "[", "]", ":"];
  return title && !forbidden.some((character) => title.includes(character))
    ? title
    : null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function columnNumber(value: string): number {
  let result = 0;
  for (const char of value.toUpperCase()) {
    result = result * 26 + char.charCodeAt(0) - 64;
  }
  return result;
}

type ParsedRange = { rows: number; columns: number; cells: number };

function parseBoundedRange(value: string | null): ParsedRange | null {
  if (!value || value.length > 180 || hasControlCharacter(value)) {
    return null;
  }
  const match = value.match(
    /^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Za-z]{1,3})([1-9]\d{0,6}):([A-Za-z]{1,3})([1-9]\d{0,6})$/,
  );
  if (!match) return null;
  const startColumn = columnNumber(match[3]);
  const endColumn = columnNumber(match[5]);
  const startRow = Number(match[4]);
  const endRow = Number(match[6]);
  if (endColumn < startColumn || endRow < startRow) return null;
  const rows = endRow - startRow + 1;
  const columns = endColumn - startColumn + 1;
  const cells = rows * columns;
  if (
    rows > MAX_WRITE_ROWS ||
    columns > MAX_WRITE_COLUMNS ||
    cells > MAX_RANGE_CELLS
  ) {
    return null;
  }
  return { rows, columns, cells };
}

function quoteSheetName(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rowsArg(value: unknown): CellValue[][] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_WRITE_ROWS
  ) {
    return null;
  }
  let width: number | null = null;
  let characters = 0;
  const rows: CellValue[][] = [];
  for (const candidate of value) {
    if (
      !Array.isArray(candidate) ||
      candidate.length < 1 ||
      candidate.length > MAX_WRITE_COLUMNS
    ) {
      return null;
    }
    if (width === null) width = candidate.length;
    if (candidate.length !== width) return null;
    const row: CellValue[] = [];
    for (const cell of candidate) {
      if (
        cell !== null &&
        typeof cell !== "string" &&
        typeof cell !== "number" &&
        typeof cell !== "boolean"
      ) {
        return null;
      }
      if (typeof cell === "number" && !Number.isFinite(cell)) return null;
      if (typeof cell === "string") characters += cell.length;
      if (characters > MAX_WRITE_CHARACTERS) return null;
      row.push(cell);
    }
    rows.push(row);
  }
  if (rows.length * (width ?? 0) > MAX_RANGE_CELLS) return null;
  return rows;
}

function readRows(value: unknown): CellValue[][] | null {
  if (!Array.isArray(value) || value.length > MAX_WRITE_ROWS) return null;
  let cells = 0;
  let characters = 0;
  const rows: CellValue[][] = [];
  for (const candidate of value) {
    if (!Array.isArray(candidate) || candidate.length > MAX_WRITE_COLUMNS) {
      return null;
    }
    const row: CellValue[] = [];
    for (const cell of candidate) {
      if (
        cell !== null &&
        typeof cell !== "string" &&
        typeof cell !== "number" &&
        typeof cell !== "boolean"
      ) {
        return null;
      }
      if (typeof cell === "number" && !Number.isFinite(cell)) return null;
      if (typeof cell === "string") characters += cell.length;
      cells += 1;
      if (cells > MAX_RANGE_CELLS || characters > MAX_WRITE_CHARACTERS) {
        return null;
      }
      row.push(cell);
    }
    rows.push(row);
  }
  return rows;
}

function valueInputOption(
  args: Record<string, unknown>,
): "RAW" | "USER_ENTERED" | null {
  const value = args.valueInputOption ?? "USER_ENTERED";
  return value === "RAW" || value === "USER_ENTERED" ? value : null;
}

type RequestResult =
  | { ok: true; body: unknown }
  | { ok: false; message: string; ambiguous: boolean };

function requestFailure(
  message: string,
  ambiguous: boolean,
): Extract<RequestResult, { ok: false }> {
  return {
    ok: false,
    ambiguous,
    message: ambiguous
      ? `${message} The write outcome is unknown. Do not retry automatically; read the target first.`
      : message,
  };
}

async function boundedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function requestJson(
  connection: Connection,
  path: string,
  input: { method?: string; query?: Record<string, string>; body?: unknown },
): Promise<RequestResult> {
  if (!connection.token) {
    return requestFailure(
      "No Google credential was available for this call.",
      false,
    );
  }
  const method = input.method ?? "GET";
  const isMutation = method !== "GET";
  const url = new URL(`${connection.url.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(input.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return requestFailure(
      "Google Sheets could not be reached before the request outcome was known.",
      isMutation,
    );
  }
  if (!response.ok) {
    const ambiguous =
      isMutation &&
      (response.status === 408 ||
        response.status === 429 ||
        response.status >= 500);
    return requestFailure(
      `Google Sheets refused this request (HTTP ${response.status}).`,
      ambiguous,
    );
  }
  const text = await boundedText(response).catch(() => null);
  if (text === null) {
    return requestFailure(
      "Google Sheets returned more data than this tool can safely process.",
      isMutation,
    );
  }
  if (text.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return requestFailure(
      "Google Sheets returned an unreadable response.",
      isMutation,
    );
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function spreadsheetLink(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

function titleFrom(body: unknown): string | null {
  const title = asRecord(asRecord(body).properties).title;
  return typeof title === "string" ? safeTitle(title, 200) : null;
}

function safeCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const spreadsheetId = stringArg(args, "spreadsheetId");
  if (toolName !== "create_google_spreadsheet" && !validId(spreadsheetId)) {
    return failure("A valid spreadsheet id is required.");
  }
  // Every branch except create was rejected above when this was absent or malformed.
  const targetSpreadsheetId = spreadsheetId ?? "";

  if (
    toolName === "get_google_sheet_metadata" ||
    toolName === "list_google_sheet_tabs"
  ) {
    const result = await requestJson(connection, `/${targetSpreadsheetId}`, {
      query: {
        fields:
          "spreadsheetId,properties(title),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))",
      },
    });
    if (!result.ok) return failure(result.message);
    const body = asRecord(result.body);
    const sheets = Array.isArray(body.sheets) ? body.sheets.slice(0, 200) : [];
    const lines = sheets.flatMap((sheet) => {
      const properties = asRecord(asRecord(sheet).properties);
      const grid = asRecord(properties.gridProperties);
      const title =
        typeof properties.title === "string"
          ? safeSheetTitle(properties.title)
          : null;
      const sheetId = safeCount(properties.sheetId, -1);
      if (!title || sheetId < 0) return [];
      const rowCount = safeCount(grid.rowCount, 0);
      const columnCount = safeCount(grid.columnCount, 0);
      return [
        `- ${title} · sheetId ${sheetId} · ${rowCount} rows × ${columnCount} columns${properties.hidden === true ? " · hidden" : ""}`,
      ];
    });
    return asResult(
      [
        "Google Sheets",
        "",
        `[${titleFrom(body) ?? "Spreadsheet"}](${spreadsheetLink(targetSpreadsheetId)})`,
        `spreadsheetId: ${targetSpreadsheetId}`,
        ...lines,
      ].join("\n"),
    );
  }

  if (toolName === "read_google_sheet_range") {
    const range = stringArg(args, "range");
    const parsed = parseBoundedRange(range);
    if (!range || !parsed) {
      return failure(
        "Range must be an explicit bounded A1 rectangle with an exact tab name, at most 500 rows, 100 columns and 10,000 cells.",
      );
    }
    const result = await requestJson(
      connection,
      `/${targetSpreadsheetId}/values/${encodeURIComponent(range)}`,
      {
        query: {
          majorDimension: "ROWS",
          valueRenderOption: "FORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING",
        },
      },
    );
    if (!result.ok) return failure(result.message);
    const body = asRecord(result.body);
    const values = readRows(body.values ?? []);
    if (!values) {
      return failure("Google Sheets returned values in an unexpected shape.");
    }
    return asResult(
      [
        "Google Sheets range",
        `spreadsheetId: ${targetSpreadsheetId}`,
        `range: ${String(body.range ?? range)}`,
        JSON.stringify(values),
      ].join("\n"),
    );
  }

  if (toolName === "create_google_spreadsheet") {
    const title = safeTitle(stringArg(args, "title"), 200);
    const firstSheetTitle =
      args.firstSheetTitle === undefined
        ? null
        : safeSheetTitle(stringArg(args, "firstSheetTitle"));
    if (!title || (args.firstSheetTitle !== undefined && !firstSheetTitle)) {
      return failure(
        "A valid spreadsheet title and optional first tab title are required.",
      );
    }
    const result = await requestJson(connection, "", {
      method: "POST",
      body: {
        properties: { title },
        ...(firstSheetTitle
          ? { sheets: [{ properties: { title: firstSheetTitle } }] }
          : {}),
      },
    });
    if (!result.ok) return failure(result.message);
    const body = asRecord(result.body);
    const createdId =
      typeof body.spreadsheetId === "string" ? body.spreadsheetId : null;
    if (!validId(createdId))
      return failure(
        "Google Sheets created a spreadsheet but returned no usable id.",
      );
    return asResult(
      [
        "Google Sheets",
        "",
        `[${titleFrom(body) ?? title}](${spreadsheetLink(createdId)})`,
        "Created",
        `spreadsheetId: ${createdId}`,
      ].join("\n"),
    );
  }

  if (toolName === "create_google_sheet_tab") {
    const sheetTitle = safeSheetTitle(stringArg(args, "sheetTitle"));
    if (!sheetTitle) return failure("A valid new tab title is required.");
    const result = await requestJson(
      connection,
      `/${targetSpreadsheetId}:batchUpdate`,
      {
        method: "POST",
        body: {
          requests: [{ addSheet: { properties: { title: sheetTitle } } }],
        },
      },
    );
    if (!result.ok) return failure(result.message);
    const replies = asRecord(result.body).replies;
    const first = Array.isArray(replies) ? asRecord(replies[0]) : {};
    const properties = asRecord(asRecord(first.addSheet).properties);
    return asResult(
      [
        "Google Sheets",
        "",
        `[${sheetTitle}](${spreadsheetLink(targetSpreadsheetId)})`,
        "Tab created",
        `spreadsheetId: ${targetSpreadsheetId}`,
        `sheetId: ${String(properties.sheetId ?? "unknown")}`,
      ].join("\n"),
    );
  }

  if (toolName === "append_google_sheet_rows") {
    const sheetName = safeSheetTitle(stringArg(args, "sheetName"));
    const rows = rowsArg(args.rows);
    const inputOption = valueInputOption(args);
    if (!sheetName || !rows || !inputOption) {
      return failure(
        "An exact tab name and a bounded rectangular row set are required.",
      );
    }
    const range = `${quoteSheetName(sheetName)}!A1`;
    const result = await requestJson(
      connection,
      `/${targetSpreadsheetId}/values/${encodeURIComponent(range)}:append`,
      {
        method: "POST",
        query: {
          valueInputOption: inputOption,
          insertDataOption: "INSERT_ROWS",
          includeValuesInResponse: "false",
        },
        body: { majorDimension: "ROWS", values: rows },
      },
    );
    if (!result.ok) {
      return failure(
        result.ambiguous
          ? `${result.message} Do not retry this append automatically; read the target rows first to avoid duplicates.`
          : result.message,
      );
    }
    const updates = asRecord(asRecord(result.body).updates);
    return asResult(
      [
        "Google Sheets",
        "",
        `[${sheetName}](${spreadsheetLink(targetSpreadsheetId)})`,
        `${String(updates.updatedRange ?? `${sheetName} (appended)`)}`,
        `${safeCount(updates.updatedRows, rows.length)} rows added · ${safeCount(updates.updatedCells, rows.length * rows[0].length)} cells`,
        `spreadsheetId: ${targetSpreadsheetId}`,
      ].join("\n"),
    );
  }

  if (toolName === "update_google_sheet_range") {
    const range = stringArg(args, "range");
    const parsed = parseBoundedRange(range);
    const rows = rowsArg(args.rows);
    const inputOption = valueInputOption(args);
    if (
      !range ||
      !parsed ||
      !rows ||
      !inputOption ||
      rows.length !== parsed.rows ||
      rows[0].length !== parsed.columns
    ) {
      return failure(
        "The bounded A1 range and rectangular row dimensions must match exactly.",
      );
    }
    const result = await requestJson(
      connection,
      `/${targetSpreadsheetId}/values/${encodeURIComponent(range)}`,
      {
        method: "PUT",
        query: {
          valueInputOption: inputOption,
          includeValuesInResponse: "false",
        },
        body: { range, majorDimension: "ROWS", values: rows },
      },
    );
    if (!result.ok) return failure(result.message);
    const body = asRecord(result.body);
    return asResult(
      [
        "Google Sheets",
        "",
        `[Open spreadsheet](${spreadsheetLink(targetSpreadsheetId)})`,
        `${String(body.updatedRange ?? range)} updated`,
        `${safeCount(body.updatedRows, rows.length)} rows · ${safeCount(body.updatedCells, parsed.cells)} cells`,
        `spreadsheetId: ${targetSpreadsheetId}`,
      ].join("\n"),
    );
  }

  if (toolName === "clear_google_sheet_range") {
    const range = stringArg(args, "range");
    const parsed = parseBoundedRange(range);
    if (!range || !parsed || args.confirm !== true) {
      return failure(
        "A bounded A1 range and confirm=true are required before values can be cleared.",
      );
    }
    const result = await requestJson(
      connection,
      `/${targetSpreadsheetId}/values/${encodeURIComponent(range)}:clear`,
      { method: "POST", body: {} },
    );
    if (!result.ok) return failure(result.message);
    const body = asRecord(result.body);
    return asResult(
      [
        "Google Sheets",
        "",
        `[Open spreadsheet](${spreadsheetLink(targetSpreadsheetId)})`,
        `${String(body.clearedRange ?? range)} cleared`,
        `spreadsheetId: ${targetSpreadsheetId}`,
      ].join("\n"),
    );
  }

  return failure(
    `${toolName} is not implemented by the Google Sheets connector. Refresh the connector tool list.`,
  );
}
