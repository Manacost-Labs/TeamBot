import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { googleDocumentEdits, googleDocumentEditState } from "../src/db/schema";

describe("confirmed Google document edit schema", () => {
  test("keeps content only in one encrypted field and defines terminal outcomes", () => {
    expect(getTableName(googleDocumentEdits)).toBe("google_document_edits");
    expect(googleDocumentEditState.enumValues).toEqual([
      "pending",
      "dispatching",
      "succeeded",
      "not_applied",
      "ambiguous",
      "expired",
      "declined",
      "superseded",
    ]);
    const config = getTableConfig(googleDocumentEdits);
    const columns = config.columns.map((column) => column.name);
    expect(columns).toContain("encrypted_payload");
    expect(columns).not.toContain("source_text");
    expect(columns).not.toContain("candidate_text");
    expect(columns).not.toContain("expected_text");
    expect(columns).not.toContain("replacement_text");
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "google_document_edits_counts_check",
      "google_document_edits_payload_state_check",
    ]);
  });
});
