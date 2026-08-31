import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { artifactExportState, artifactExports } from "../src/db/schema";

describe("artifact export schema", () => {
  test("keeps content out of the idempotency record", () => {
    expect(getTableName(artifactExports)).toBe("artifact_exports");
    expect(artifactExportState.enumValues).toEqual([
      "creating",
      "ready",
      "failed",
    ]);
    const config = getTableConfig(artifactExports);
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "owner_user_id",
      "channel_id",
      "bot_id",
      "run_id",
      "request_fingerprint",
      "state",
      "attachment_id",
      "lease_token",
      "lease_expires_at",
      "attempts",
      "created_at",
      "updated_at",
    ]);
    expect(
      config.columns.some((column) =>
        /content|html|markdown|base64|bytes|path/i.test(column.name),
      ),
    ).toBe(false);
  });

  test("has one owner-scoped request key, recovery index, and state checks", () => {
    const config = getTableConfig(artifactExports);
    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        unique: index.config.unique,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
      })),
    ).toEqual([
      {
        name: "artifact_exports_request_key",
        unique: true,
        columns: [
          "owner_user_id",
          "channel_id",
          "bot_id",
          "run_id",
          "request_fingerprint",
        ],
      },
      {
        name: "artifact_exports_recovery_idx",
        unique: false,
        columns: ["state", "lease_expires_at", "updated_at"],
      },
    ]);
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "artifact_exports_attempts_check",
      "artifact_exports_fingerprint_check",
      "artifact_exports_identity_length_check",
      "artifact_exports_lease_state_check",
    ]);
    const [membership] = config.foreignKeys;
    const reference = membership?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      "channel_id",
      "owner_user_id",
    ]);
    expect(getTableName(reference?.foreignTable as never)).toBe(
      "channel_memberships",
    );
    expect(membership?.onDelete).toBe("no action");
  });
});
