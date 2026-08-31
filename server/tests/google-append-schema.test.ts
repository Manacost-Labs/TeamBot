import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  googleAppendOperationState,
  googleAppendOperations,
} from "../src/db/schema";

describe("Google append operation schema", () => {
  test("stores identities and outcomes without append content", () => {
    expect(getTableName(googleAppendOperations)).toBe(
      "google_append_operations",
    );
    expect(googleAppendOperationState.enumValues).toEqual([
      "prepared",
      "dispatching",
      "succeeded",
      "ambiguous",
      "not_applied",
    ]);

    const config = getTableConfig(googleAppendOperations);
    const columns = config.columns.map((column) => column.name);
    expect(columns).toEqual([
      "id",
      "actor_id",
      "bot_id",
      "run_id",
      "server_id",
      "tool_name",
      "target_id",
      "location_fingerprint",
      "request_fingerprint",
      "state",
      "lease_token",
      "lease_expires_at",
      "dispatch_started_at",
      "finished_at",
      "attempts",
      "item_count",
      "cell_count",
      "created_at",
      "updated_at",
    ]);
    expect(
      columns.some((name) =>
        /args|payload|rows|text|content|result/i.test(name),
      ),
    ).toBe(false);
  });

  test("has one run-scoped request key and state constraints", () => {
    const config = getTableConfig(googleAppendOperations);
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
        name: "google_append_operations_request_key",
        unique: true,
        columns: [
          "actor_id",
          "bot_id",
          "run_id",
          "server_id",
          "tool_name",
          "request_fingerprint",
        ],
      },
      {
        name: "google_append_operations_recovery_idx",
        unique: false,
        columns: ["state", "lease_expires_at", "dispatch_started_at"],
      },
    ]);
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "google_append_operations_attempts_check",
      "google_append_operations_counts_check",
      "google_append_operations_fingerprints_check",
      "google_append_operations_identity_length_check",
      "google_append_operations_state_check",
      "google_append_operations_tool_check",
    ]);
  });
});
