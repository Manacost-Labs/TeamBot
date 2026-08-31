import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { googleAppendOperations } from "../db/schema";

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_DISPATCH_STALE_MS = 120_000;
const MAX_ID_LENGTH = 256;
const MAX_WRITE_ROWS = 500;
const MAX_WRITE_COLUMNS = 100;
const MAX_RANGE_CELLS = 10_000;
const MAX_WRITE_CHARACTERS = 200_000;
const MAX_APPEND_CHARS = 10_000;

type CellValue = string | number | boolean | null;
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type GoogleAppendPlan = Readonly<{
  toolName: "append_google_doc" | "append_google_sheet_rows";
  targetId: string;
  location: JsonValue;
  payload: JsonValue;
  itemCount: number;
  cellCount: number | null;
}>;

export type GoogleAppendFingerprint = Readonly<{
  requestFingerprint: string;
  locationFingerprint: string;
  targetId: string;
  itemCount: number;
  cellCount: number | null;
}>;

export type GoogleAppendContext = Readonly<{
  actorId: string;
  botId: string;
  runId: string;
  serverId: string;
  plan: GoogleAppendPlan;
}>;

export type GoogleAppendClaim =
  | Readonly<{
      kind: "claimed";
      operationId: string;
      leaseToken: string;
    }>
  | Readonly<{ kind: "succeeded"; operationId: string }>
  | Readonly<{ kind: "ambiguous"; operationId: string }>
  | Readonly<{ kind: "busy"; operationId: string }>;

export type GoogleAppendOperationStore = Readonly<{
  claim(
    context: GoogleAppendContext,
    leaseMs?: number,
  ): Promise<GoogleAppendClaim>;
  beginDispatch(operationId: string, leaseToken: string): Promise<boolean>;
  complete(
    operationId: string,
    leaseToken: string,
    outcome: "succeeded" | "ambiguous" | "not_applied",
  ): Promise<boolean>;
}>;

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validId(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 &&
    trimmed.length <= MAX_ID_LENGTH &&
    pattern.test(trimmed)
    ? trimmed
    : null;
}

function validSheetName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 100 ||
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    ["\\", "/", "?", "*", "[", "]", ":"].some((character) =>
      trimmed.includes(character),
    )
  ) {
    return null;
  }
  return trimmed;
}

function validRows(value: unknown): CellValue[][] | null {
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
    width ??= candidate.length;
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
  return rows.length * (width ?? 0) <= MAX_RANGE_CELLS ? rows : null;
}

/** Parse and normalize exactly the append arguments that can reach Google. */
export function planGoogleAppend(
  toolName: string,
  args: Record<string, unknown>,
): GoogleAppendPlan | null {
  if (toolName === "append_google_sheet_rows") {
    if (
      !hasOnlyKeys(args, [
        "spreadsheetId",
        "sheetName",
        "rows",
        "valueInputOption",
      ])
    ) {
      return null;
    }
    const spreadsheetId = validId(args.spreadsheetId, /^[A-Za-z0-9_-]+$/);
    const sheetName = validSheetName(args.sheetName);
    const rows = validRows(args.rows);
    const valueInputOption = args.valueInputOption ?? "USER_ENTERED";
    if (
      !spreadsheetId ||
      !sheetName ||
      !rows ||
      (valueInputOption !== "RAW" && valueInputOption !== "USER_ENTERED")
    ) {
      return null;
    }
    return Object.freeze({
      toolName,
      targetId: spreadsheetId,
      location: { sheetName, range: "A1" },
      payload: { rows, valueInputOption },
      itemCount: rows.length,
      cellCount: rows.length * rows[0].length,
    });
  }

  if (toolName === "append_google_doc") {
    if (!hasOnlyKeys(args, ["documentId", "tabId", "text"])) return null;
    const documentId = validId(args.documentId, /^[A-Za-z0-9_-]+$/);
    const tabId =
      args.tabId === undefined
        ? null
        : validId(args.tabId, /^[A-Za-z0-9_.-]+$/);
    const text = args.text;
    if (
      !documentId ||
      (args.tabId !== undefined && !tabId) ||
      typeof text !== "string" ||
      text.length < 1 ||
      text.length > MAX_APPEND_CHARS
    ) {
      return null;
    }
    return Object.freeze({
      toolName,
      targetId: documentId,
      location: { tabId: tabId ?? "implicit-single-tab", position: "end" },
      payload: { text },
      itemCount: [...text].length,
      cellCount: null,
    });
  }

  return null;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const item = value[key];
      if (item === undefined) {
        throw new Error("Canonical append identity contains undefined");
      }
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    })
    .join(",")}}`;
}

function fingerprint(value: JsonValue): string {
  return createHash("sha256")
    .update("openbot-google-append:v1\0")
    .update(canonicalJson(value))
    .digest("hex");
}

/** Only digests and safe cardinalities leave this function; append content does not. */
export function googleAppendFingerprint(
  context: GoogleAppendContext,
): GoogleAppendFingerprint {
  const locationFingerprint = fingerprint({
    toolName: context.plan.toolName,
    targetId: context.plan.targetId,
    location: context.plan.location,
  });
  const requestFingerprint = fingerprint({
    actorId: context.actorId,
    botId: context.botId,
    runId: context.runId,
    serverId: context.serverId,
    toolName: context.plan.toolName,
    targetId: context.plan.targetId,
    location: context.plan.location,
    payload: context.plan.payload,
  });
  return Object.freeze({
    requestFingerprint,
    locationFingerprint,
    targetId: context.plan.targetId,
    itemCount: context.plan.itemCount,
    cellCount: context.plan.cellCount,
  });
}

function validIdentity(value: string, maximum: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  );
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
    throw new Error(
      "Google append duration must be a positive bounded integer",
    );
  }
  return value;
}

type OperationRow = {
  id: string;
  state: "prepared" | "dispatching" | "succeeded" | "ambiguous" | "not_applied";
};

/** PostgreSQL state machine that never reclaims an operation after external dispatch began. */
export function createGoogleAppendOperationStore(
  database: Database,
  options: Readonly<{ dispatchStaleAfterMs?: number }> = {},
): GoogleAppendOperationStore {
  const dispatchStaleAfterMs = boundedDuration(
    options.dispatchStaleAfterMs,
    DEFAULT_DISPATCH_STALE_MS,
  );

  return Object.freeze({
    async claim(context, requestedLeaseMs) {
      if (
        !validIdentity(context.actorId, 255) ||
        !validIdentity(context.botId, 255) ||
        !validIdentity(context.runId, 4_096) ||
        !validIdentity(context.serverId, 255)
      ) {
        throw new Error("Invalid Google append identity");
      }
      const leaseMs = boundedDuration(requestedLeaseMs, DEFAULT_LEASE_MS);
      const identity = googleAppendFingerprint(context);
      const leaseToken = randomUUID();

      return database.transaction(async (transaction) => {
        await transaction
          .update(googleAppendOperations)
          .set({
            state: "ambiguous",
            leaseToken: null,
            leaseExpiresAt: null,
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(googleAppendOperations.actorId, context.actorId),
              eq(googleAppendOperations.botId, context.botId),
              eq(googleAppendOperations.runId, context.runId),
              eq(googleAppendOperations.serverId, context.serverId),
              eq(googleAppendOperations.toolName, context.plan.toolName),
              eq(
                googleAppendOperations.requestFingerprint,
                identity.requestFingerprint,
              ),
              eq(googleAppendOperations.state, "dispatching"),
              sql`${googleAppendOperations.dispatchStartedAt} <= now() - (${dispatchStaleAfterMs} * interval '1 millisecond')`,
            ),
          );

        const claimed = await transaction.execute<OperationRow>(sql`
          insert into ${googleAppendOperations} (
            "actor_id", "bot_id", "run_id", "server_id", "tool_name",
            "target_id", "location_fingerprint", "request_fingerprint", "state",
            "lease_token", "lease_expires_at", "item_count", "cell_count"
          ) values (
            ${context.actorId}, ${context.botId}, ${context.runId}, ${context.serverId},
            ${context.plan.toolName}, ${identity.targetId}, ${identity.locationFingerprint},
            ${identity.requestFingerprint}, 'prepared', ${leaseToken}::uuid,
            now() + (${leaseMs} * interval '1 millisecond'), ${identity.itemCount},
            ${identity.cellCount}
          )
          on conflict (
            "actor_id", "bot_id", "run_id", "server_id", "tool_name", "request_fingerprint"
          ) do update set
            "state" = 'prepared',
            "lease_token" = ${leaseToken}::uuid,
            "lease_expires_at" = now() + (${leaseMs} * interval '1 millisecond'),
            "dispatch_started_at" = null,
            "finished_at" = null,
            "attempts" = ${googleAppendOperations.attempts} + 1,
            "updated_at" = now()
          where ${googleAppendOperations.state} = 'not_applied'
            or (
              ${googleAppendOperations.state} = 'prepared'
              and ${googleAppendOperations.leaseExpiresAt} <= now()
            )
          returning "id", "state"
        `);
        const owned = claimed[0];
        if (owned) {
          return { kind: "claimed", operationId: owned.id, leaseToken };
        }

        const existing = await transaction.execute<OperationRow>(sql`
          select "id", "state"
          from ${googleAppendOperations}
          where "actor_id" = ${context.actorId}
            and "bot_id" = ${context.botId}
            and "run_id" = ${context.runId}
            and "server_id" = ${context.serverId}
            and "tool_name" = ${context.plan.toolName}
            and "request_fingerprint" = ${identity.requestFingerprint}
          limit 1
        `);
        const row = existing[0];
        if (!row) throw new Error("Google append operation disappeared");
        return row.state === "succeeded"
          ? { kind: "succeeded", operationId: row.id }
          : row.state === "ambiguous"
            ? { kind: "ambiguous", operationId: row.id }
            : { kind: "busy", operationId: row.id };
      });
    },

    async beginDispatch(operationId, leaseToken) {
      const [row] = await database
        .update(googleAppendOperations)
        .set({
          state: "dispatching",
          leaseExpiresAt: null,
          dispatchStartedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(googleAppendOperations.id, operationId),
            eq(googleAppendOperations.state, "prepared"),
            eq(googleAppendOperations.leaseToken, leaseToken),
            sql`${googleAppendOperations.leaseExpiresAt} > now()`,
          ),
        )
        .returning({ id: googleAppendOperations.id });
      return row !== undefined;
    },

    async complete(operationId, leaseToken, outcome) {
      const allowedStates =
        outcome === "not_applied"
          ? (["prepared", "dispatching"] as const)
          : (["dispatching"] as const);
      const [row] = await database
        .update(googleAppendOperations)
        .set({
          state: outcome,
          leaseToken: null,
          leaseExpiresAt: null,
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(googleAppendOperations.id, operationId),
            inArray(googleAppendOperations.state, allowedStates),
            eq(googleAppendOperations.leaseToken, leaseToken),
          ),
        )
        .returning({ id: googleAppendOperations.id });
      return row !== undefined;
    },
  });
}
