import { describe, expect, test } from "bun:test";
import { parseGoogleWorkspaceResult } from "./result";

describe("Google Workspace result cards", () => {
  test("parses a governed Docs creation without exposing its internal id", () => {
    expect(
      parseGoogleWorkspaceResult(
        "mcp__google-drive__create_google_doc",
        '"Created Google Doc: [Quarterly plan](https://docs.google.com/document/d/doc_123/edit)\\nDocument id: doc_123"',
      ),
    ).toEqual({
      kind: "document",
      title: "Quarterly plan",
      status: "Документ создан",
      details: [],
      url: "https://docs.google.com/document/d/doc_123/edit",
    });
  });

  test("keeps the useful range and row confirmation for a Sheets append", () => {
    expect(
      parseGoogleWorkspaceResult(
        "mcp__google-drive__append_google_sheet_rows",
        [
          "Google Sheets",
          "",
          "[Research](https://docs.google.com/spreadsheets/d/sheet_1/edit)",
          "Research!A2:B3",
          "2 rows added · 4 cells",
          "spreadsheetId: sheet_1",
        ].join("\n"),
      ),
    ).toEqual({
      kind: "spreadsheet",
      title: "Research",
      status: "Строки добавлены",
      details: ["Research!A2:B3", "2 rows added · 4 cells"],
      url: "https://docs.google.com/spreadsheets/d/sheet_1/edit",
    });
  });

  test("does not promote failures, unknown tools or untrusted links", () => {
    expect(
      parseGoogleWorkspaceResult(
        "mcp__google-drive__create_google_doc",
        "The vendor reported an error: denied",
      ),
    ).toBeNull();
    expect(
      parseGoogleWorkspaceResult(
        "mcp__google-drive__read_google_document",
        "[Plan](https://docs.google.com/document/d/doc_123/edit)",
      ),
    ).toBeNull();
    expect(
      parseGoogleWorkspaceResult(
        "mcp__google-drive__create_google_doc",
        "[Plan](https://evil.test/document/d/doc_123/edit)",
      ),
    ).toBeNull();
    expect(
      parseGoogleWorkspaceResult(
        "mcp__google-drive__create_google_doc",
        "[Plan](https://docs.google.com/document/d/doc_123/edit?token=secret)",
      ),
    ).toBeNull();
    expect(
      parseGoogleWorkspaceResult(
        "mcp__google-drive__create_google_doc",
        "[Wrong product](https://docs.google.com/spreadsheets/d/sheet_1/edit)",
      ),
    ).toBeNull();
  });
});
