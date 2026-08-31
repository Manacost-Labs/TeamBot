import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { googleDocumentEdits } from "../db/schema";
import type { ConfirmedGoogleDocumentEditPlan } from "../plugins/google-workspace-rest";
import type { PluginStore } from "../plugins/store";
import type { TrustedToolCallContext } from "../plugins/transport";

const DEFAULT_TTL_MS = 15 * 60_000;
const DISPATCH_STALE_MS = 2 * 60_000;
const MAX_TEXT_CHARS = 500_000;

export type GoogleDocumentEditState =
  | "pending"
  | "dispatching"
  | "succeeded"
  | "not_applied"
  | "ambiguous"
  | "expired"
  | "declined"
  | "superseded";

type StoredPlan = ConfirmedGoogleDocumentEditPlan;

export type GoogleDocumentEditReview = Readonly<{
  id: string;
  state: GoogleDocumentEditState;
  botId: string;
  documentId: string;
  editCount: number;
  removedCharacters: number;
  insertedCharacters: number;
  expiresAt: string;
  edits: ReadonlyArray<
    Readonly<{ position: number; before: string; after: string }>
  >;
}>;

export type PreparedGoogleDocumentEdit = Readonly<{
  id: string;
  state: "pending";
  expiresAt: string;
  editCount: number;
  reviewPath: string;
}>;

type OperationRow = {
  id: string;
  actorId: string;
  botId: string;
  sourceRunId: string;
  threadId: string;
  documentId: string;
  tabId: string;
  proposalDigest: string;
  encryptedPayload: string | null;
  state: GoogleDocumentEditState;
  editCount: number;
  removedCharacters: number;
  insertedCharacters: number;
  expiresAt: Date;
  dispatchStartedAt: Date | null;
};

function digestPlan(plan: StoredPlan): string {
  return createHash("sha256")
    .update("openbot-google-document-edit:v1\0")
    .update(JSON.stringify(plan))
    .digest("hex");
}

function validIdentity(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  );
}

function terminalState(
  outcome: "applied" | "not_applied" | "ambiguous",
): GoogleDocumentEditState {
  return outcome === "applied" ? "succeeded" : outcome;
}

export function createGoogleDocumentEditService(options: {
  database: Database;
  pluginStore: PluginStore;
  encryptionKey: string;
  auditStore: AuditStore;
  ttlMs?: number;
}) {
  const { database, pluginStore, encryptionKey, auditStore } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) {
    throw new Error(
      "Google document edit TTL must be between one and sixty minutes",
    );
  }

  async function expireAndRecover(id: string, actorId: string): Promise<void> {
    await database
      .update(googleDocumentEdits)
      .set({
        state: "expired",
        encryptedPayload: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(googleDocumentEdits.id, id),
          eq(googleDocumentEdits.actorId, actorId),
          eq(googleDocumentEdits.state, "pending"),
          sql`${googleDocumentEdits.expiresAt} <= now()`,
        ),
      );
    await database
      .update(googleDocumentEdits)
      .set({
        state: "ambiguous",
        encryptedPayload: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(googleDocumentEdits.id, id),
          eq(googleDocumentEdits.actorId, actorId),
          eq(googleDocumentEdits.state, "dispatching"),
          sql`${googleDocumentEdits.dispatchStartedAt} <= now() - (${DISPATCH_STALE_MS} * interval '1 millisecond')`,
        ),
      );
  }

  async function rowFor(
    id: string,
    actorId: string,
  ): Promise<OperationRow | null> {
    const [row] = await database
      .select()
      .from(googleDocumentEdits)
      .where(
        and(
          eq(googleDocumentEdits.id, id),
          eq(googleDocumentEdits.actorId, actorId),
        ),
      )
      .limit(1);
    return (row as OperationRow | undefined) ?? null;
  }

  async function reviewFromRow(
    row: OperationRow,
  ): Promise<GoogleDocumentEditReview> {
    let edits: Array<{ position: number; before: string; after: string }> = [];
    if (row.encryptedPayload && row.state === "pending") {
      try {
        const plan = JSON.parse(
          await decryptSecret(encryptionKey, row.encryptedPayload),
        ) as StoredPlan;
        if (digestPlan(plan) === row.proposalDigest) {
          edits = plan.edits.map((edit) => ({
            position: edit.startIndex,
            before: edit.expectedText,
            after: edit.replacementText,
          }));
        }
      } catch {
        edits = [];
      }
    }
    return Object.freeze({
      id: row.id,
      state: row.state,
      botId: row.botId,
      documentId: row.documentId,
      editCount: row.editCount,
      removedCharacters: row.removedCharacters,
      insertedCharacters: row.insertedCharacters,
      expiresAt: row.expiresAt.toISOString(),
      edits: Object.freeze(edits.map((edit) => Object.freeze(edit))),
    });
  }

  return Object.freeze({
    async prepare(
      input: TrustedToolCallContext & {
        documentId: string;
        sourceText: string;
        candidateText: string;
      },
    ): Promise<PreparedGoogleDocumentEdit> {
      if (
        !input.threadId ||
        !validIdentity(input.actorId, 255) ||
        !validIdentity(input.botId, 255) ||
        !validIdentity(input.runId ?? "", 4_096) ||
        !validIdentity(input.threadId, 4_096) ||
        input.sourceText.length < 1 ||
        input.candidateText.length < 1 ||
        input.sourceText.length > MAX_TEXT_CHARS ||
        input.candidateText.length > MAX_TEXT_CHARS
      ) {
        throw new Error(
          "A bounded signed editor run is required to prepare this save.",
        );
      }

      const planned = await pluginStore.planConfirmedGoogleDocumentEdit(input);
      if (!planned.ok) throw new Error(planned.message);
      const plan = planned.plan;
      const digest = digestPlan(plan);
      const encryptedPayload = await encryptSecret(
        encryptionKey,
        JSON.stringify(plan),
      );
      const removedCharacters = plan.edits.reduce(
        (total, edit) => total + edit.expectedText.length,
        0,
      );
      const insertedCharacters = plan.edits.reduce(
        (total, edit) => total + edit.replacementText.length,
        0,
      );
      const expiresAt = new Date(Date.now() + ttlMs);

      const row = await database.transaction(async (transaction) => {
        const lockKey = JSON.stringify([
          input.actorId,
          input.botId,
          input.threadId,
          plan.documentId,
        ]);
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
        );
        await transaction
          .update(googleDocumentEdits)
          .set({
            state: "superseded",
            encryptedPayload: null,
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(googleDocumentEdits.actorId, input.actorId),
              eq(googleDocumentEdits.botId, input.botId),
              eq(googleDocumentEdits.threadId, input.threadId as string),
              eq(googleDocumentEdits.documentId, plan.documentId),
              eq(googleDocumentEdits.state, "pending"),
            ),
          );
        const [created] = await transaction
          .insert(googleDocumentEdits)
          .values({
            actorId: input.actorId,
            botId: input.botId,
            sourceRunId: input.runId as string,
            threadId: input.threadId as string,
            documentId: plan.documentId,
            tabId: plan.tabId,
            proposalDigest: digest,
            encryptedPayload,
            state: "pending",
            editCount: plan.edits.length,
            removedCharacters,
            insertedCharacters,
            expiresAt,
          })
          .returning({ id: googleDocumentEdits.id });
        if (!created) throw new Error("The editor proposal was not stored.");
        return created;
      });

      await recordAuditEvent(auditStore, {
        eventType: "google_doc_edit.proposed",
        targetType: "google_doc_edit",
        targetId: row.id,
        actorUserId: input.actorId,
        payload: {
          bot: input.botId,
          run: input.runId,
          editCount: plan.edits.length,
          removedCharacters,
          insertedCharacters,
          expiresAt: expiresAt.toISOString(),
        },
      });
      return Object.freeze({
        id: row.id,
        state: "pending",
        expiresAt: expiresAt.toISOString(),
        editCount: plan.edits.length,
        reviewPath: `/editor/google-doc-edits/${row.id}`,
      });
    },

    async get(
      id: string,
      actorId: string,
    ): Promise<GoogleDocumentEditReview | null> {
      await expireAndRecover(id, actorId);
      const row = await rowFor(id, actorId);
      return row ? reviewFromRow(row) : null;
    },

    async decide(
      id: string,
      actorId: string,
      decision: "approve" | "decline",
    ): Promise<GoogleDocumentEditReview | null> {
      await expireAndRecover(id, actorId);
      if (decision === "decline") {
        const [declined] = await database
          .update(googleDocumentEdits)
          .set({
            state: "declined",
            encryptedPayload: null,
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(googleDocumentEdits.id, id),
              eq(googleDocumentEdits.actorId, actorId),
              eq(googleDocumentEdits.state, "pending"),
              sql`${googleDocumentEdits.expiresAt} > now()`,
            ),
          )
          .returning({ id: googleDocumentEdits.id });
        if (declined) {
          await recordAuditEvent(auditStore, {
            eventType: "google_doc_edit.declined",
            targetType: "google_doc_edit",
            targetId: id,
            actorUserId: actorId,
            payload: {},
          });
        }
        const row = await rowFor(id, actorId);
        return row ? reviewFromRow(row) : null;
      }

      const [claimed] = await database
        .update(googleDocumentEdits)
        .set({
          state: "dispatching",
          dispatchStartedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(googleDocumentEdits.id, id),
            eq(googleDocumentEdits.actorId, actorId),
            eq(googleDocumentEdits.state, "pending"),
            sql`${googleDocumentEdits.expiresAt} > now()`,
          ),
        )
        .returning();
      if (!claimed) {
        const existing = await rowFor(id, actorId);
        return existing ? reviewFromRow(existing) : null;
      }

      const claimedRow = claimed as OperationRow;
      let plan: StoredPlan;
      try {
        if (!claimedRow.encryptedPayload) throw new Error("missing payload");
        plan = JSON.parse(
          await decryptSecret(encryptionKey, claimedRow.encryptedPayload),
        ) as StoredPlan;
        if (digestPlan(plan) !== claimedRow.proposalDigest) {
          throw new Error("digest mismatch");
        }
      } catch {
        await database
          .update(googleDocumentEdits)
          .set({
            state: "not_applied",
            encryptedPayload: null,
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(googleDocumentEdits.id, id),
              eq(googleDocumentEdits.state, "dispatching"),
            ),
          );
        const failed = await rowFor(id, actorId);
        return failed ? reviewFromRow(failed) : null;
      }

      let state: GoogleDocumentEditState = "ambiguous";
      try {
        const result = await pluginStore.applyConfirmedGoogleDocumentEdit({
          actorId,
          botId: claimedRow.botId,
          runId: claimedRow.sourceRunId,
          threadId: claimedRow.threadId,
          operationId: id,
          plan,
        });
        state = terminalState(result.outcome);
      } catch {
        // Once dispatching begins, an unexpected lost reply can never be retried safely.
        state = "ambiguous";
      }

      await database
        .update(googleDocumentEdits)
        .set({
          state,
          encryptedPayload: null,
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(googleDocumentEdits.id, id),
            eq(googleDocumentEdits.state, "dispatching"),
          ),
        );
      await recordAuditEvent(auditStore, {
        eventType:
          state === "succeeded"
            ? "google_doc_edit.applied"
            : state === "ambiguous"
              ? "google_doc_edit.ambiguous"
              : "google_doc_edit.not_applied",
        targetType: "google_doc_edit",
        targetId: id,
        actorUserId: actorId,
        payload: {
          bot: claimedRow.botId,
          editCount: claimedRow.editCount,
          outcome: state,
        },
      });
      const completed = await rowFor(id, actorId);
      return completed ? reviewFromRow(completed) : null;
    },
  });
}

export type GoogleDocumentEditService = ReturnType<
  typeof createGoogleDocumentEditService
>;
