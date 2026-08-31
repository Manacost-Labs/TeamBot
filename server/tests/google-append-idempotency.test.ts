import { describe, expect, test } from "bun:test";
import {
  googleAppendFingerprint,
  planGoogleAppend,
} from "../src/plugins/google-append-idempotency";

const context = {
  actorId: "user-1",
  botId: "agent-1",
  runId: "run-1",
  serverId: "google-drive",
};

describe("Google append request identity", () => {
  test("normalizes the Sheets input default before fingerprinting", () => {
    const implicit = planGoogleAppend("append_google_sheet_rows", {
      spreadsheetId: "sheet_1",
      sheetName: "Research",
      rows: [["private value", 1]],
    });
    const explicit = planGoogleAppend("append_google_sheet_rows", {
      spreadsheetId: "sheet_1",
      sheetName: "Research",
      rows: [["private value", 1]],
      valueInputOption: "USER_ENTERED",
    });

    expect(implicit).not.toBeNull();
    expect(explicit).not.toBeNull();
    expect(
      googleAppendFingerprint({ ...context, plan: implicit! })
        .requestFingerprint,
    ).toBe(
      googleAppendFingerprint({ ...context, plan: explicit! })
        .requestFingerprint,
    );
  });

  test("binds actor, run, tool, target, location, and payload", () => {
    const first = planGoogleAppend("append_google_doc", {
      documentId: "doc_1",
      tabId: "tab_main",
      text: "private text",
    });
    const otherPayload = planGoogleAppend("append_google_doc", {
      documentId: "doc_1",
      tabId: "tab_main",
      text: "different private text",
    });
    if (!first || !otherPayload) throw new Error("Expected valid plans");

    const fingerprint = (overrides: Record<string, unknown> = {}) =>
      googleAppendFingerprint({
        ...context,
        plan: first,
        ...overrides,
      } as never).requestFingerprint;

    expect(fingerprint({ actorId: "user-2" })).not.toBe(fingerprint());
    expect(fingerprint({ runId: "run-2" })).not.toBe(fingerprint());
    expect(
      googleAppendFingerprint({ ...context, plan: otherPayload })
        .requestFingerprint,
    ).not.toBe(fingerprint());
  });

  test("returns only hashes and safe counts, never appended content", () => {
    const plan = planGoogleAppend("append_google_sheet_rows", {
      spreadsheetId: "sheet_1",
      sheetName: "Research",
      rows: [["do-not-store-this", 1]],
    });
    if (!plan) throw new Error("Expected a valid plan");

    const identity = googleAppendFingerprint({ ...context, plan });
    expect(identity.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.locationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(identity)).not.toContain("do-not-store-this");
    expect(identity.itemCount).toBe(1);
    expect(identity.cellCount).toBe(2);
  });
});
