import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * Google Drive, reached over its ordinary REST API instead of its MCP server.
 *
 * WHY THIS EXISTS. Google publishes a hosted MCP server for Drive, `drivemcp.googleapis.com`, and
 * pointing the catalogue at it was the original design: a vendor-maintained server needs no code
 * here at all. It is gated behind the Google Workspace Developer Preview Program, and refuses an
 * unenrolled project with `The caller does not have permission` — a statement about the project,
 * not the credential, so every check available locally says the setup is correct. It is.
 *
 * The REST API underneath has been generally available since 2015. So this trades "no code" for "no
 * dependency on a preview", which for a connector people rely on is the better side of the trade.
 *
 * WHAT MAKES IT SWAPPABLE. This module implements the interface {@link ./mcp} already had —
 * `listTools` and `callTool`, same shapes — rather than inventing one for itself. MCP is therefore
 * not the default with an exception carved out of it; both are implementations of the same contract,
 * chosen per catalogue entry by {@link ./transport}. Going back to the MCP server when the preview
 * opens is one field on one entry, with nothing else in the system aware it changed.
 *
 * The TOOL NAMES are deliberately the ones Google's MCP server advertises, character for character.
 * A grant is stored as `google-drive/search_files`, so keeping the names identical means every grant
 * an administrator has already made keeps working across the swap, in either direction. Diverging
 * here would silently turn switching transports into re-granting every tool on every Bot.
 *
 * Read-only, and only the tools that can be implemented faithfully. Google's MCP server also
 * advertises writes; the `drive.readonly` scope refuses them, and nothing here offers them.
 */

/** Long enough for a slow listing, short enough that a Bot's turn is not held open on it. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many files a listing returns before the model is reading a directory rather than an answer. */
const PAGE_SIZE = 25;

/** Search strings are human phrases, not a place for an unbounded Drive query language program. */
const MAX_SEARCH_CHARS = 200;

/** Drive ids are opaque but currently use only URL-safe base64-like characters. */
const MAX_ID_CHARS = 256;

/** Four UTF-8 bytes per result character, plus room for metadata around the content. */
const MAX_RESPONSE_BYTES = MAX_RESULT_CHARS * 4 + 16_384;

/**
 * The fields asked for, rather than Drive's default.
 *
 * Drive returns a thin projection unless asked, and `webViewLink` is the one worth naming: a result
 * carrying it lets a Bot cite a file as a link somebody can open, which is the difference between an
 * answer and an assertion about an answer.
 */
const FILE_FIELDS =
  "id,name,mimeType,createdTime,modifiedTime,webViewLink,size,parents,owners(emailAddress),description";

/**
 * Google's editor formats, and the plain-text export each one has.
 *
 * A Doc has no bytes to download — `alt=media` refuses it — so it has to be exported. Anything not
 * in here is a real file and is fetched directly.
 */
const EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/** Text formats that are both supported by Drive and safe to return through an MCP text result. */
const TEXT_EXPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  {
    "application/vnd.google-apps.document": Object.freeze([
      "text/plain",
      "text/markdown",
    ]),
    "application/vnd.google-apps.spreadsheet": Object.freeze([
      "text/csv",
      "text/tab-separated-values",
    ]),
    "application/vnd.google-apps.presentation": Object.freeze(["text/plain"]),
  },
);

const DRIVE_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: MAX_ID_CHARS,
  pattern: "^[A-Za-z0-9_-]+$",
} as const;

const SEARCH_TERM_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: MAX_SEARCH_CHARS,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
} as const;

/**
 * What this adapter offers, as the same shape a server would have answered `tools/list` with.
 *
 * Static, and that is the point of difference from MCP: there is no remote list to discover, so
 * `refreshTools` records what this code can actually do. A tool listed here that the dispatcher
 * below does not handle would be advertised to a model and then fail, so the two are kept adjacent.
 */
const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "search_files",
    description:
      "Search the files in your Google Drive by name and full text. Returns matching files with their names, types, last modified times and links.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          ...SEARCH_TERM_SCHEMA,
          description:
            "Legacy combined search across the file name/title and indexed contents.",
        },
        name: {
          ...SEARCH_TERM_SCHEMA,
          description: "Text that the Drive filename/title must contain.",
        },
        keywords: {
          ...SEARCH_TERM_SCHEMA,
          description: "Keywords that the indexed file contents must contain.",
        },
        mimeType: {
          type: "string",
          minLength: 3,
          maxLength: 255,
          pattern:
            "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$",
          description: "An exact MIME type to match.",
        },
        modifiedAfter: {
          type: "string",
          format: "date-time",
          maxLength: 40,
          description: "Only files modified after this RFC 3339 timestamp.",
        },
        modifiedBefore: {
          type: "string",
          format: "date-time",
          maxLength: 40,
          description: "Only files modified before this RFC 3339 timestamp.",
        },
        folderId: {
          ...DRIVE_ID_SCHEMA,
          description: "Only direct children of this Drive folder.",
        },
      },
      anyOf: [
        { required: ["query"] },
        { required: ["keywords"] },
        { required: ["name"] },
        { required: ["mimeType"] },
        { required: ["modifiedAfter"] },
        { required: ["modifiedBefore"] },
        { required: ["folderId"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "list_recent_files",
    description:
      "List the files in your Google Drive that changed most recently, newest first.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_folder",
    description:
      "List the direct children of one Google Drive folder, ordered by filename/title.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: {
          ...DRIVE_ID_SCHEMA,
          description: "The Drive folder id whose direct children to list.",
        },
      },
      required: ["folderId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_file_metadata",
    description:
      "Get the name, type, size, owner, last modified time and link for one file, by its id.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: {
          ...DRIVE_ID_SCHEMA,
          description: "The file's Drive id.",
        },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file_content",
    description:
      "Read the text of one file in your Google Drive, by its id. Google Docs, Sheets and Slides are exported as text.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: {
          ...DRIVE_ID_SCHEMA,
          description: "The file's Drive id.",
        },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
  {
    name: "export_file",
    description:
      "Export a native Google Doc, Sheet or Slide into a supported text format. Binary exports are not returned by this connector.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: {
          ...DRIVE_ID_SCHEMA,
          description: "The native Google Workspace file's Drive id.",
        },
        mimeType: {
          type: "string",
          enum: [
            "text/plain",
            "text/markdown",
            "text/csv",
            "text/tab-separated-values",
          ],
          description: "The requested text export MIME type.",
        },
      },
      required: ["fileId", "mimeType"],
      additionalProperties: false,
    },
  },
]);

type Connection = { url: string; token?: string };

/**
 * No credential is needed to know what this adapter can do, because the answer is in this file.
 *
 * This is not a detail. Assuming otherwise made configuring Drive a four-stop journey: an
 * administrator enabling the connector was refused at "refresh tools" until they had gone to their
 * own settings page and connected a personal Google account, whose token was then handed to
 * {@link listTools} — which ignores it — and thrown away. The gate was real and the work behind it
 * was not.
 */
export const listNeedsCredential = false;

/** The same list for everybody, because this adapter's capability is this code rather than a server. */
export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

/**
 * One request to Drive, with the caller's own token.
 *
 * `token` is never optional in practice here — Drive is `user-oauth`, so the store has already
 * refused a call with nobody's credential before this module is reached — but it is typed optional
 * by the shared connection shape, so a missing one is named rather than sent as `Bearer undefined`.
 */
async function request(
  connection: Connection,
  path: string,
  query: Record<string, string>,
): Promise<{ ok: true; response: Response } | { ok: false; message: string }> {
  if (!connection.token) {
    return { ok: false, message: "No credential was available for this call." };
  }

  const url = new URL(`${connection.url.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${connection.token}` },
      // A bearer token is only for Google's pinned API host, never a redirect target.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "Google Drive did not answer in time."
          : "Google Drive could not be reached. Try again shortly.",
    };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const message = (() => {
      if (response.status === 401)
        return "Google Drive authorization is no longer valid. Reconnect the Google account and try again.";
      if (response.status === 403)
        return "Google Drive denied access. Check that the Drive API is enabled and that the connected account has the required permissions.";
      if (response.status === 404)
        return "Google Drive could not find that file or folder, or the connected account cannot access it.";
      if (response.status === 429)
        return "Google Drive is temporarily rate-limiting requests. Try again shortly.";
      if (response.status >= 500)
        return "Google Drive is temporarily unavailable. Try again shortly.";
      return `Google Drive refused this request (${response.status}).`;
    })();
    return {
      ok: false,
      message,
    };
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      message:
        "Google Drive returned content that is too large for a conversation tool result.",
    };
  }

  return { ok: true, response };
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Read at most the amount that can become one bounded model result. */
async function readResponseText(
  response: Response,
): Promise<ReadResult<string>> {
  if (!response.body) return { ok: true, value: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          message:
            "Google Drive returned content that is too large for a conversation tool result.",
        };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: text };
  } catch {
    await reader.cancel().catch(() => undefined);
    return {
      ok: false,
      message: "Google Drive returned unreadable text content.",
    };
  }
}

async function readResponseJson<T>(response: Response): Promise<ReadResult<T>> {
  const body = await readResponseText(response);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.value) as T };
  } catch {
    return {
      ok: false,
      message: "Google Drive returned an invalid response.",
    };
  }
}

/**
 * Whether this type's bytes can be read as text at all.
 *
 * An allow list, not a deny list. New binary formats appear constantly and each one added to a deny
 * list is a format that reached a model as mojibake first; the textual families are few and stable.
 * `application/*` is deliberately not included wholesale — it holds JSON and XML, and also PDFs,
 * archives and every office format.
 */
function isTextual(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/x-ndjson",
    "application/yaml",
    "application/x-yaml",
    "application/sql",
    "application/toml",
  ].includes(type);
}

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  parents?: string[];
  owners?: { emailAddress?: string }[];
  description?: string;
};

/**
 * One file as a line a model can quote.
 *
 * The id is included because every other tool here takes one, and a model that has just been shown a
 * file it cannot then read is a dead end it will try to talk its way out of.
 */
function fileLine(file: DriveFile): string {
  const name = file.name ?? "(untitled)";
  /*
   * A markdown link, not a bare URL beside a name.
   *
   * This is K1's acceptance criterion rather than decoration: "the answer carries a link that opens
   * the actual file". Tool results are drawn through a markdown renderer, so a link is a link a
   * reader can click, and one the model can carry into its own prose when it cites the file. A bare
   * URL depends on the renderer choosing to autolink, and reads as noise when it does not.
   *
   * The brackets in the name are escaped because a `]` in a file name would otherwise close the link
   * text early and leave the rest of the name and the URL as literal characters on screen.
   */
  const parts = [
    file.webViewLink
      ? `[${name.replace(/\[/g, "\\[").replace(/\]/g, "\\]")}](${file.webViewLink})`
      : name,
  ];
  if (file.mimeType) parts.push(file.mimeType);
  if (file.modifiedTime) parts.push(`modified ${file.modifiedTime}`);
  // Kept even though the link carries it: every other tool here takes an id, and a model that has
  // to parse one out of a URL will sometimes get it wrong.
  if (file.id) parts.push(`id: ${file.id}`);
  return `- ${parts.join(" · ")}`;
}

/**
 * A Drive query string built from what somebody typed.
 *
 * The quote is escaped, not stripped. Drive's `q` syntax delimits with single quotes, so an
 * apostrophe in a search term would otherwise end the clause and change the query's meaning —
 * searching for `don't` would become a syntax error at best, and at worst a different search than
 * the one asked for. Escaped, a term is only ever a term.
 */
const escapeDriveQueryValue = (query: string) =>
  query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const driveQuery = (query: string) => {
  const escaped = escapeDriveQueryValue(query);
  return `name contains '${escaped}' or fullText contains '${escaped}'`;
};

/**
 * Text as an MCP result, through the one function that decides what a model is told.
 *
 * Reused rather than reimplemented so the empty case and the size cap behave identically across both
 * transports. The empty case is the one that matters: a search that matched nothing has to SAY so,
 * because an empty string reads to a model as "the tool had nothing to say" and gets filled in from
 * memory — which for a knowledge connector is the exact failure the lane exists to prevent.
 */
function asResult(text: string): McpCallResult {
  const joined = text.trim();
  if (joined === "") {
    return {
      text: "The tool returned no content. Nothing was found, so there is nothing here to answer from.",
      isError: false,
      truncated: false,
    };
  }
  if (joined.length <= MAX_RESULT_CHARS) {
    return { text: joined, isError: false, truncated: false };
  }
  return {
    text: `${joined.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${joined.length} characters]`,
    isError: false,
    truncated: true,
  };
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DRIVE_ID = /^[A-Za-z0-9_-]+$/;
const MIME_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function unexpectedArgument(
  args: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const extra = Object.keys(args).find((key) => !allowed.includes(key));
  return extra ? `The argument ${extra} is not supported by this tool.` : null;
}

function textArgument(
  args: Record<string, unknown>,
  key: string,
  label: string,
  options: { required?: boolean; maxLength?: number } = {},
): ReadResult<string | undefined> {
  const value = args[key];
  if (value === undefined) {
    return options.required
      ? { ok: false, message: `${label} is required.` }
      : { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: `${label} must be a non-empty string.` };
  }
  const trimmed = value.trim();
  if (trimmed.length > (options.maxLength ?? MAX_SEARCH_CHARS)) {
    return { ok: false, message: `${label} is too long.` };
  }
  if (hasControlCharacter(trimmed)) {
    return { ok: false, message: `${label} contains unsupported characters.` };
  }
  return { ok: true, value: trimmed };
}

function idArgument(
  args: Record<string, unknown>,
  key: string,
  label: string,
  required = true,
): ReadResult<string | undefined> {
  const parsed = textArgument(args, key, label, {
    required,
    maxLength: MAX_ID_CHARS,
  });
  if (!parsed.ok || parsed.value === undefined) return parsed;
  return DRIVE_ID.test(parsed.value)
    ? parsed
    : { ok: false, message: `${label} is not a valid Drive id.` };
}

function mimeArgument(
  args: Record<string, unknown>,
  required = false,
): ReadResult<string | undefined> {
  const parsed = textArgument(args, "mimeType", "The MIME type", {
    required,
    maxLength: 255,
  });
  if (!parsed.ok || parsed.value === undefined) return parsed;
  return MIME_TYPE.test(parsed.value)
    ? parsed
    : { ok: false, message: "The MIME type is invalid." };
}

function dateArgument(
  args: Record<string, unknown>,
  key: "modifiedAfter" | "modifiedBefore",
): ReadResult<string | undefined> {
  const parsed = textArgument(args, key, key, { maxLength: 40 });
  if (!parsed.ok || parsed.value === undefined) return parsed;
  return RFC3339.test(parsed.value) && !Number.isNaN(Date.parse(parsed.value))
    ? parsed
    : { ok: false, message: `${key} must be an RFC 3339 timestamp.` };
}

function scopedDriveQuery(args: Record<string, unknown>): ReadResult<string> {
  const allowed = [
    "query",
    "name",
    "keywords",
    "mimeType",
    "modifiedAfter",
    "modifiedBefore",
    "folderId",
  ] as const;
  const extra = unexpectedArgument(args, allowed);
  if (extra) return { ok: false, message: extra };

  const query = textArgument(args, "query", "The search query");
  const name = textArgument(args, "name", "The filename/title");
  const keywords = textArgument(args, "keywords", "The keywords");
  const mimeType = mimeArgument(args);
  const modifiedAfter = dateArgument(args, "modifiedAfter");
  const modifiedBefore = dateArgument(args, "modifiedBefore");
  const folderId = idArgument(args, "folderId", "The folder id", false);
  if (!query.ok) return query;
  if (!name.ok) return name;
  if (!keywords.ok) return keywords;
  if (!mimeType.ok) return mimeType;
  if (!modifiedAfter.ok) return modifiedAfter;
  if (!modifiedBefore.ok) return modifiedBefore;
  if (!folderId.ok) return folderId;

  if (
    modifiedAfter.value &&
    modifiedBefore.value &&
    Date.parse(modifiedAfter.value) >= Date.parse(modifiedBefore.value)
  ) {
    return {
      ok: false,
      message: "modifiedAfter must be earlier than modifiedBefore.",
    };
  }

  const clauses: string[] = [];
  if (query.value) clauses.push(`(${driveQuery(query.value)})`);
  if (name.value)
    clauses.push(`name contains '${escapeDriveQueryValue(name.value)}'`);
  if (keywords.value)
    clauses.push(
      `fullText contains '${escapeDriveQueryValue(keywords.value)}'`,
    );
  if (mimeType.value)
    clauses.push(`mimeType = '${escapeDriveQueryValue(mimeType.value)}'`);
  if (modifiedAfter.value)
    clauses.push(`modifiedTime > '${modifiedAfter.value}'`);
  if (modifiedBefore.value)
    clauses.push(`modifiedTime < '${modifiedBefore.value}'`);
  if (folderId.value) clauses.push(`'${folderId.value}' in parents`);
  if (clauses.length === 0) {
    return { ok: false, message: "A search needs at least one filter." };
  }
  clauses.push("trashed = false");
  return { ok: true, value: clauses.join(" and ") };
}

function driveFiles(value: unknown): ReadResult<DriveFile[]> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("files" in value) ||
    !Array.isArray(value.files)
  ) {
    return { ok: false, message: "Google Drive returned an invalid response." };
  }
  return {
    ok: true,
    value: value.files.flatMap((file) => {
      const normalized = normalizeDriveFile(file);
      return normalized ? [normalized] : [];
    }),
  };
}

function normalizeDriveFile(value: unknown): DriveFile | null {
  if (typeof value !== "object" || value === null) return null;
  const file = value as Record<string, unknown>;
  const optionalString = (key: string) =>
    typeof file[key] === "string" ? (file[key] as string) : undefined;
  const owners = Array.isArray(file.owners)
    ? file.owners.flatMap((owner) => {
        if (typeof owner !== "object" || owner === null) return [];
        const emailAddress = (owner as Record<string, unknown>).emailAddress;
        return typeof emailAddress === "string" ? [{ emailAddress }] : [];
      })
    : undefined;
  const parents = Array.isArray(file.parents)
    ? file.parents.filter(
        (parent): parent is string => typeof parent === "string",
      )
    : undefined;
  return {
    id: optionalString("id"),
    name: optionalString("name"),
    mimeType: optionalString("mimeType"),
    createdTime: optionalString("createdTime"),
    modifiedTime: optionalString("modifiedTime"),
    webViewLink: optionalString("webViewLink"),
    size: optionalString("size"),
    parents,
    owners,
    description: optionalString("description"),
  };
}

async function readMetadata(
  connection: Connection,
  fileId: string,
  fields = FILE_FIELDS,
): Promise<ReadResult<DriveFile>> {
  const result = await request(
    connection,
    `/files/${encodeURIComponent(fileId)}`,
    { fields },
  );
  if (!result.ok) return result;
  const body = await readResponseJson<unknown>(result.response);
  if (!body.ok) return body;
  const file = normalizeDriveFile(body.value);
  if (!file) {
    return { ok: false, message: "Google Drive returned an invalid response." };
  }
  return { ok: true, value: file };
}

async function listDriveFiles(
  connection: Connection,
  query: Record<string, string>,
): Promise<McpCallResult> {
  const result = await request(connection, "/files", {
    pageSize: String(PAGE_SIZE),
    fields: `files(${FILE_FIELDS})`,
    ...query,
  });
  if (!result.ok) return failure(result.message);
  const body = await readResponseJson<unknown>(result.response);
  if (!body.ok) return failure(body.message);
  const files = driveFiles(body.value);
  return files.ok
    ? asResult(files.value.map(fileLine).join("\n"))
    : failure(files.message);
}

/**
 * Call one tool.
 *
 * Whether the call was permitted is decided before this module, exactly as it is for MCP. This
 * dispatches and formats, and nothing else — an unknown tool is refused here rather than guessed at,
 * because a tool name that reaches this point and is not in {@link TOOLS} means the stored tool list
 * and this code have diverged, which is a bug to surface rather than to absorb.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (toolName === "search_files") {
    const query = scopedDriveQuery(args);
    return query.ok
      ? listDriveFiles(connection, { q: query.value })
      : failure(query.message);
  }

  if (toolName === "list_recent_files") {
    const extra = unexpectedArgument(args, []);
    if (extra) return failure(extra);
    return listDriveFiles(connection, {
      q: "trashed = false",
      orderBy: "modifiedTime desc",
    });
  }

  if (toolName === "list_folder") {
    const extra = unexpectedArgument(args, ["folderId"]);
    if (extra) return failure(extra);
    const folderId = idArgument(args, "folderId", "The folder id");
    if (!folderId.ok || !folderId.value)
      return failure(
        folderId.ok ? "The folder id is required." : folderId.message,
      );
    return listDriveFiles(connection, {
      q: `'${folderId.value}' in parents and trashed = false`,
      orderBy: "name_natural",
    });
  }

  if (toolName === "get_file_metadata") {
    const extra = unexpectedArgument(args, ["fileId"]);
    if (extra) return failure(extra);
    const fileId = idArgument(args, "fileId", "The file id");
    if (!fileId.ok || !fileId.value)
      return failure(
        fileId.ok ? "A file id is needed to look a file up." : fileId.message,
      );
    const metadata = await readMetadata(connection, fileId.value);
    if (!metadata.ok) return failure(metadata.message);
    const file = metadata.value;
    const owner = file.owners?.[0]?.emailAddress;
    return asResult(
      [
        fileLine(file),
        file.createdTime ? `created: ${file.createdTime}` : null,
        file.size ? `size: ${file.size} bytes` : null,
        owner ? `owner: ${owner}` : null,
        file.parents?.length ? `parent ids: ${file.parents.join(", ")}` : null,
        file.description ? `description: ${file.description}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (toolName === "read_file_content") {
    const extra = unexpectedArgument(args, ["fileId"]);
    if (extra) return failure(extra);
    const fileId = idArgument(args, "fileId", "The file id");
    if (!fileId.ok || !fileId.value)
      return failure(
        fileId.ok ? "A file id is needed to read a file." : fileId.message,
      );

    /*
     * The type is looked up first, because how a file is read depends on what it is. A Doc has no
     * bytes and must be exported; anything else is downloaded. Asking Drive rather than guessing from
     * the name means a mislabelled file still reads correctly.
     */
    const metadata = await readMetadata(
      connection,
      fileId.value,
      "id,name,mimeType",
    );
    if (!metadata.ok) return failure(metadata.message);
    const file = metadata.value;

    const exportAs = file.mimeType ? EXPORTABLE[file.mimeType] : undefined;

    /*
     * A file whose bytes are not text is declined by name, not decoded and hoped for.
     *
     * `response.text()` on a PDF, an image or a zip produces thousands of replacement characters and
     * mojibake, and that goes straight into a model's context: it costs the tokens of the real
     * document, tells the model nothing, and looks enough like content that the model will try to
     * summarise it. Saying which type it is instead lets the model do the one useful thing available
     * — name the file and its type, and stop — and keeps a link the person can open themselves.
     *
     * Only positively-known-textual types are read. Anything unrecognised is declined, for the same
     * reason an unknown tool counts as a write: guessing permissively here is not recoverable, since
     * nothing downstream can tell garbage from content.
     */
    if (!exportAs && !isTextual(file.mimeType)) {
      return failure(
        `${file.name ?? fileId.value} is a ${file.mimeType ?? "binary"} file, which this connector cannot read as text. Its metadata and link are available, and somebody can open it themselves.`,
      );
    }

    const content = exportAs
      ? await request(
          connection,
          `/files/${encodeURIComponent(fileId.value)}/export`,
          { mimeType: exportAs },
        )
      : await request(
          connection,
          `/files/${encodeURIComponent(fileId.value)}`,
          {
            alt: "media",
          },
        );
    if (!content.ok) return failure(content.message);

    const text = await readResponseText(content.response);
    if (!text.ok) return failure(text.message);
    // Named, because a model handed only the body cannot cite what it read.
    return asResult(`${file.name ?? fileId.value}\n\n${text.value}`);
  }

  if (toolName === "export_file") {
    const extra = unexpectedArgument(args, ["fileId", "mimeType"]);
    if (extra) return failure(extra);
    const fileId = idArgument(args, "fileId", "The file id");
    const mimeType = mimeArgument(args, true);
    if (!fileId.ok || !fileId.value)
      return failure(
        fileId.ok ? "A file id is needed to export a file." : fileId.message,
      );
    if (!mimeType.ok || !mimeType.value)
      return failure(
        mimeType.ok ? "An export MIME type is required." : mimeType.message,
      );

    const allTextFormats = new Set(Object.values(TEXT_EXPORTS).flat());
    if (!allTextFormats.has(mimeType.value)) {
      return failure(
        "This connector supports text-only exports. Binary exports require a protected artifact gateway.",
      );
    }

    const metadata = await readMetadata(
      connection,
      fileId.value,
      "id,name,mimeType",
    );
    if (!metadata.ok) return failure(metadata.message);
    const file = metadata.value;
    const supported = file.mimeType ? TEXT_EXPORTS[file.mimeType] : undefined;
    if (!supported?.includes(mimeType.value)) {
      return failure(
        `${file.name ?? fileId.value} (${file.mimeType ?? "unknown type"}) cannot be exported as ${mimeType.value} by this text-only connector.`,
      );
    }

    const exported = await request(
      connection,
      `/files/${encodeURIComponent(fileId.value)}/export`,
      { mimeType: mimeType.value },
    );
    if (!exported.ok) return failure(exported.message);
    const text = await readResponseText(exported.response);
    if (!text.ok) return failure(text.message);
    return asResult(
      `${file.name ?? fileId.value} (${mimeType.value})\n\n${text.value}`,
    );
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
