import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { attachmentSource, attachments } from "../src/db/schema";

describe("attachment metadata schema", () => {
  test("stores bounded metadata and an object key, never attachment bytes", () => {
    expect(getTableName(attachments)).toBe("attachments");
    expect(attachmentSource.enumName).toBe("attachment_source");
    expect(attachmentSource.enumValues).toEqual([
      "user_upload",
      "agent_generated",
      "tool_generated",
      "google_export",
    ]);

    const config = getTableConfig(attachments);
    expect(
      config.columns.map((column) => ({
        name: column.name,
        sqlType: column.getSQLType(),
        notNull: column.notNull,
        primary: column.primary,
      })),
    ).toEqual([
      { name: "id", sqlType: "uuid", notNull: true, primary: true },
      {
        name: "owner_user_id",
        sqlType: "text",
        notNull: true,
        primary: false,
      },
      {
        name: "channel_id",
        sqlType: "text",
        notNull: true,
        primary: false,
      },
      {
        name: "message_id",
        sqlType: "text",
        notNull: false,
        primary: false,
      },
      {
        name: "name",
        sqlType: "varchar(512)",
        notNull: true,
        primary: false,
      },
      {
        name: "mime_type",
        sqlType: "varchar(255)",
        notNull: true,
        primary: false,
      },
      {
        name: "size",
        sqlType: "bigint",
        notNull: true,
        primary: false,
      },
      {
        name: "sha256",
        sqlType: "char(64)",
        notNull: true,
        primary: false,
      },
      {
        name: "storage_key",
        sqlType: "varchar(1024)",
        notNull: true,
        primary: false,
      },
      {
        name: "source",
        sqlType: "attachment_source",
        notNull: true,
        primary: false,
      },
      {
        name: "created_at",
        sqlType: "timestamp with time zone",
        notNull: true,
        primary: false,
      },
    ]);

    const forbiddenColumns = config.columns.filter((column) =>
      /blob|base64/i.test(column.name),
    );
    const binaryColumns = config.columns.filter(
      (column) => column.getSQLType().toLowerCase() === "bytea",
    );
    expect(forbiddenColumns).toEqual([]);
    expect(binaryColumns).toEqual([]);
    expect(attachments.storageKey.isUnique).toBe(true);
  });

  test("binds every attachment to the owner's membership without cascade deletion", () => {
    const config = getTableConfig(attachments);
    expect(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          source: reference.columns.map((column) => column.name),
          targetTable: getTableName(reference.foreignTable),
          target: reference.foreignColumns.map((column) => column.name),
          onDelete: foreignKey.onDelete,
        };
      }),
    ).toEqual([
      {
        source: ["channel_id", "owner_user_id"],
        targetTable: "channel_memberships",
        target: ["channel_id", "user_id"],
        onDelete: "no action",
      },
    ]);

    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
        unique: index.config.unique,
      })),
    ).toEqual([
      {
        name: "attachments_owner_channel_created_idx",
        columns: ["owner_user_id", "channel_id", "created_at", "id"],
        unique: false,
      },
      {
        name: "attachments_owner_channel_message_idx",
        columns: ["owner_user_id", "channel_id", "message_id"],
        unique: false,
      },
    ]);

    expect(config.checks.map((constraint) => constraint.name).sort()).toEqual([
      "attachments_channel_id_length_check",
      "attachments_message_id_length_check",
      "attachments_mime_type_length_check",
      "attachments_name_length_check",
      "attachments_owner_user_id_length_check",
      "attachments_sha256_check",
      "attachments_size_check",
      "attachments_storage_key_length_check",
    ]);
  });
});
