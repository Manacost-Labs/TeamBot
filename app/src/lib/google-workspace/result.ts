import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";

const GOOGLE_SERVER_PREFIX = "mcp__google-drive__";

const WRITE_RESULTS = new Map<
  string,
  Pick<GoogleWorkspaceResult, "kind" | "status">
>([
  ["create_google_doc", { kind: "document", status: "Документ создан" }],
  ["append_google_doc", { kind: "document", status: "Документ обновлён" }],
  [
    "replace_google_doc_range",
    { kind: "document", status: "Фрагмент документа обновлён" },
  ],
  [
    "create_google_spreadsheet",
    { kind: "spreadsheet", status: "Таблица создана" },
  ],
  [
    "create_google_sheet_tab",
    { kind: "spreadsheet", status: "Вкладка создана" },
  ],
  [
    "append_google_sheet_rows",
    { kind: "spreadsheet", status: "Строки добавлены" },
  ],
  [
    "update_google_sheet_range",
    { kind: "spreadsheet", status: "Диапазон обновлён" },
  ],
  [
    "clear_google_sheet_range",
    { kind: "spreadsheet", status: "Диапазон очищен" },
  ],
]);

export type GoogleWorkspaceResult = {
  kind: "document" | "spreadsheet";
  title: string;
  status: string;
  details: string[];
  url: string;
};

function safeGoogleEditorUrl(value: string): {
  kind: GoogleWorkspaceResult["kind"];
  url: string;
} | null {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://docs.google.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const match =
      /^\/(document|spreadsheets)\/d\/[A-Za-z0-9_-]+\/edit\/?$/.exec(
        url.pathname,
      );
    if (!match) return null;
    return {
      kind: match[1] === "document" ? "document" : "spreadsheet",
      url: url.toString(),
    };
  } catch {
    return null;
  }
}

function cleanLinkTitle(value: string): string {
  return value
    .replace(/\\([\\[\]])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function usefulDetails(bodyWithoutLink: string, title: string): string[] {
  return bodyWithoutLink
    .split("\n")
    .map((line) =>
      line
        .replace(/^Created Google Doc:\s*/i, "")
        .replace(/^Google (?:Docs|Sheets)(?: range)?\s*$/i, "")
        .trim(),
    )
    .filter(
      (line) =>
        line.length > 0 &&
        line !== title &&
        !/^(?:document id|spreadsheetId|sheetId):/i.test(line) &&
        !/^(?:Created|Tab created)$/i.test(line),
    )
    .slice(0, 2);
}

/**
 * A successful governed Google write, narrowed to the safe fields a result card needs.
 *
 * The server writes ordinary Markdown for the model. The browser does not trust arbitrary Markdown
 * to become a privileged card: the exact first-party server/tool name must match, the result must
 * carry a pinned docs.google.com editor URL, and credentials/query fragments are refused. Anything
 * else stays on the normal tool-result path where failures and third-party output belong.
 */
export function parseGoogleWorkspaceResult(
  name: string,
  result: string | undefined,
): GoogleWorkspaceResult | null {
  if (!name.startsWith(GOOGLE_SERVER_PREFIX) || result === undefined) {
    return null;
  }
  const toolName = name.slice(GOOGLE_SERVER_PREFIX.length);
  const expected = WRITE_RESULTS.get(toolName);
  if (!expected) return null;

  const body = asText(result).trim();
  if (
    !body ||
    body.startsWith(REFUSAL_MARKER) ||
    body.startsWith("The vendor reported an error:") ||
    body.startsWith("That tool could not be called:")
  ) {
    return null;
  }

  const link = /\[((?:\\.|[^\]])+)\]\((https:\/\/[^\s)]+)\)/.exec(body);
  if (!link) return null;
  const destination = safeGoogleEditorUrl(link[2]);
  if (!destination || destination.kind !== expected.kind) return null;

  const linkedTitle = cleanLinkTitle(link[1]);
  const title =
    /^(?:open (?:spreadsheet|document)|google (?:docs|sheets))$/i.test(
      linkedTitle,
    )
      ? destination.kind === "document"
        ? "Google Документ"
        : "Google Таблица"
      : linkedTitle;
  if (!title || title.length > 200) return null;

  return {
    ...destination,
    title,
    status: expected.status,
    details: usefulDetails(
      `${body.slice(0, link.index)}${title}${body.slice(link.index + link[0].length)}`,
      title,
    ),
  };
}
