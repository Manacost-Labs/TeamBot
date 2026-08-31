import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { googleAppendOperations } from "../src/db/schema";
import {
  createGoogleAppendOperationStore,
  planGoogleAppend,
} from "../src/plugins/google-append-idempotency";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suite = randomUUID().slice(0, 8);
const actorId = `google_append_${suite}`;
const context = () => {
  const plan = planGoogleAppend("append_google_sheet_rows", {
    spreadsheetId: "sheet_1",
    sheetName: "Research",
    rows: [["private cell", 1]],
  });
  if (!plan) throw new Error("Expected a valid append plan");
  return {
    actorId,
    botId: "agent-1",
    runId: "run-1",
    serverId: "google-drive",
    plan,
  };
};

afterAll(async () => {
  await database
    .delete(googleAppendOperations)
    .where(eq(googleAppendOperations.actorId, actorId));
  await database.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await database
    .delete(googleAppendOperations)
    .where(eq(googleAppendOperations.actorId, actorId));
});

describe("durable Google append claims", () => {
  test("one replica claims a request and concurrent replicas do not", async () => {
    const firstStore = createGoogleAppendOperationStore(database);
    const secondStore = createGoogleAppendOperationStore(database);
    const [first, second] = await Promise.all([
      firstStore.claim(context()),
      secondStore.claim(context()),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["busy", "claimed"]);
  });

  test("a succeeded append replays after the store is recreated", async () => {
    const store = createGoogleAppendOperationStore(database);
    const claimed = await store.claim(context());
    if (claimed.kind !== "claimed") throw new Error("Expected a claim");
    expect(
      await store.beginDispatch(claimed.operationId, claimed.leaseToken),
    ).toBe(true);
    expect(
      await store.complete(
        claimed.operationId,
        claimed.leaseToken,
        "succeeded",
      ),
    ).toBe(true);

    const restarted = createGoogleAppendOperationStore(database);
    expect(await restarted.claim(context())).toEqual({
      kind: "succeeded",
      operationId: claimed.operationId,
    });
  });

  test("an ambiguous outcome is terminal across a restart", async () => {
    const store = createGoogleAppendOperationStore(database);
    const claimed = await store.claim(context());
    if (claimed.kind !== "claimed") throw new Error("Expected a claim");
    await store.beginDispatch(claimed.operationId, claimed.leaseToken);
    await store.complete(claimed.operationId, claimed.leaseToken, "ambiguous");

    expect(
      await createGoogleAppendOperationStore(database).claim(context()),
    ).toEqual({ kind: "ambiguous", operationId: claimed.operationId });
  });

  test("a stale dispatch becomes ambiguous rather than being reclaimed", async () => {
    const store = createGoogleAppendOperationStore(database, {
      dispatchStaleAfterMs: 1,
    });
    const claimed = await store.claim(context());
    if (claimed.kind !== "claimed") throw new Error("Expected a claim");
    await store.beginDispatch(claimed.operationId, claimed.leaseToken);
    await database
      .update(googleAppendOperations)
      .set({ dispatchStartedAt: sql`now() - interval '1 minute'` })
      .where(eq(googleAppendOperations.id, claimed.operationId));

    expect(await store.claim(context())).toEqual({
      kind: "ambiguous",
      operationId: claimed.operationId,
    });
  });

  test("only a pre-dispatch or definitely not-applied request may be reclaimed", async () => {
    const store = createGoogleAppendOperationStore(database);
    const first = await store.claim(context());
    if (first.kind !== "claimed") throw new Error("Expected a claim");
    await store.complete(first.operationId, first.leaseToken, "not_applied");

    const second = await store.claim(context());
    expect(second.kind).toBe("claimed");
    if (second.kind !== "claimed") throw new Error("Expected a second claim");
    expect(second.operationId).toBe(first.operationId);
    expect(second.leaseToken).not.toBe(first.leaseToken);
  });

  test("an expired prepared owner cannot dispatch after another owner reclaims it", async () => {
    const store = createGoogleAppendOperationStore(database);
    const first = await store.claim(context());
    if (first.kind !== "claimed") throw new Error("Expected a claim");
    await database
      .update(googleAppendOperations)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(googleAppendOperations.id, first.operationId));

    const second = await store.claim(context());
    if (second.kind !== "claimed") throw new Error("Expected a reclaim");
    expect(await store.beginDispatch(first.operationId, first.leaseToken)).toBe(
      false,
    );
    expect(
      await store.beginDispatch(second.operationId, second.leaseToken),
    ).toBe(true);
  });

  test("the durable row contains no appended values", async () => {
    await createGoogleAppendOperationStore(database).claim(context());
    const [row] = await database
      .select()
      .from(googleAppendOperations)
      .where(eq(googleAppendOperations.actorId, actorId));

    expect(JSON.stringify(row)).not.toContain("private cell");
  });
});
