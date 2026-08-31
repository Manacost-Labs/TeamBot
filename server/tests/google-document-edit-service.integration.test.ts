import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createGoogleDocumentEditService } from "../src/editor/google-document-edits";
import { createDatabase } from "../src/db/client";
import { agents, googleDocumentEdits, users } from "../src/db/schema";
import type { PluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suffix = randomUUID().slice(0, 8);
const actorId = `google_edit_actor_${suffix}`;
const botId = `google-edit-bot-${suffix}`;
const encryptionKey = Buffer.alloc(32, 7).toString("base64");

let applyCalls = 0;
const pluginStore = {
  async planConfirmedGoogleDocumentEdit() {
    return {
      ok: true as const,
      plan: {
        documentId: "doc_private_123",
        revisionId: "private-revision",
        tabId: "tab_main",
        edits: [
          {
            startIndex: 1,
            endIndex: 15,
            expectedText: "private before",
            replacementText: "private after",
          },
        ],
      },
    };
  },
  async applyConfirmedGoogleDocumentEdit() {
    applyCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      text: "applied",
      isError: false,
      outcome: "applied" as const,
    };
  },
} as unknown as PluginStore;
const auditStore = { insert: async () => undefined };
const service = createGoogleDocumentEditService({
  database,
  pluginStore,
  encryptionKey,
  auditStore,
});

beforeAll(async () => {
  await database.insert(users).values({
    id: actorId,
    email: `${actorId}@example.test`,
  });
  await database.insert(agents).values({
    id: botId,
    name: "Confirmed editor test",
    type: "remote_ag_ui",
    configuration: { endpoint: "https://editor.example.test/ag-ui" },
  });
});

afterAll(async () => {
  await database
    .delete(googleDocumentEdits)
    .where(eq(googleDocumentEdits.actorId, actorId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, actorId));
  await database.$client.end({ timeout: 5 });
});

describe("durable confirmed Google document edits", () => {
  test("two concurrent approvals dispatch once and erase document prose", async () => {
    applyCalls = 0;
    const prepared = await service.prepare({
      actorId,
      botId,
      runId: "run-1",
      threadId: "thread-1",
      documentId: "doc_private_123",
      sourceText: "private before",
      candidateText: "private after",
    });
    expect(prepared.state).toBe("pending");

    await Promise.all([
      service.decide(prepared.id, actorId, "approve"),
      service.decide(prepared.id, actorId, "approve"),
    ]);
    expect(applyCalls).toBe(1);
    expect((await service.get(prepared.id, actorId))?.state).toBe("succeeded");

    const [stored] = await database
      .select()
      .from(googleDocumentEdits)
      .where(eq(googleDocumentEdits.id, prepared.id));
    expect(stored?.encryptedPayload).toBeNull();
    expect(JSON.stringify(stored)).not.toContain("private before");
    expect(JSON.stringify(stored)).not.toContain("private after");
  });

  test("a newer proposal supersedes the older pending payload", async () => {
    const first = await service.prepare({
      actorId,
      botId,
      runId: "run-2",
      threadId: "thread-2",
      documentId: "doc_private_123",
      sourceText: "private before",
      candidateText: "private after",
    });
    const second = await service.prepare({
      actorId,
      botId,
      runId: "run-3",
      threadId: "thread-2",
      documentId: "doc_private_123",
      sourceText: "private before",
      candidateText: "private after",
    });
    expect((await service.get(first.id, actorId))?.state).toBe("superseded");
    expect((await service.get(second.id, actorId))?.state).toBe("pending");
  });
});
