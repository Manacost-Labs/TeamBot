import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createRoutineRoutes } from "../src/routines/routes";
import {
  RoutineNotFoundError,
  RoutineOverlapError,
  RoutineRefusedError,
  type RoutineStore,
  type RoutineSummary,
} from "../src/routines/store";

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

function summary(overrides: Partial<RoutineSummary> = {}): RoutineSummary {
  return {
    id: "routine-1",
    agentId: "agent-1",
    instruction: "Post the weather every weekday morning.",
    schedule: "Weekdays at 09:00",
    cron: "0 9 * * 1-5",
    timezone: "UTC",
    enabled: true,
    nextRunAt: new Date("2026-08-27T09:00:00.000Z"),
    channelId: "channel-1",
    channelName: "Assistant channel",
    channelDeleted: false,
    lastRun: {
      status: "succeeded",
      finishedAt: new Date("2026-08-26T09:00:00.000Z"),
    },
    ...overrides,
  };
}

type StoreCall = [method: keyof RoutineStore, ...arguments_: unknown[]];

function fakeStore(
  overrides: Partial<RoutineStore> = {},
): RoutineStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const base: RoutineStore = {
    async create() {
      throw new Error("not used by these tests");
    },
    async listFor(ownerUserId) {
      calls.push(["listFor", ownerUserId]);
      return [summary()];
    },
    async update() {
      throw new Error("not used by these tests");
    },
    async remove(ownerUserId, id) {
      calls.push(["remove", ownerUserId, id]);
    },
    async setEnabled(ownerUserId, id, enabled) {
      calls.push(["setEnabled", ownerUserId, id, enabled]);
    },
    async dueRoutines() {
      return [];
    },
    async advanceNextRun() {
      return false;
    },
    async insertRun() {
      return { runId: "routine_run-1" };
    },
    async runContext() {
      return null;
    },
    async routineForFiring() {
      return null;
    },
    async finishRun() {},
    async consecutiveFailures() {
      return 0;
    },
  };

  return Object.assign(base, overrides, { calls });
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
  Promise.resolve(context.json({ error: "denied" }, 401));

function appFor(
  store: RoutineStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
  options: Parameters<typeof createRoutineRoutes>[2] = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createRoutineRoutes(store, middleware, options));
  return app;
}

async function json(response: Response) {
  return response.json();
}

describe("GET /", () => {
  test("lists the caller's own routines as words, not cron", async () => {
    const store = fakeStore();
    const response = await appFor(store).request("http://openbot.test/");

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      routines: [
        {
          id: "routine-1",
          agentId: "agent-1",
          schedule: "Weekdays at 09:00",
          cron: "0 9 * * 1-5",
          timezone: "UTC",
          instruction: "Post the weather every weekday morning.",
          channel: { id: "channel-1", name: "Assistant channel", gone: false },
          enabled: true,
          nextRunAt: "2026-08-27T09:00:00.000Z",
          lastRun: { status: "succeeded", at: "2026-08-26T09:00:00.000Z" },
          overlapPolicy: "skip",
        },
      ],
    });
    expect(store.calls).toEqual([["listFor", actor.id]]);
  });

  test("carries no lastRun when the routine has never fired", async () => {
    const store = fakeStore({
      listFor: async () => [summary({ lastRun: null })],
    });
    const response = await appFor(store).request("http://openbot.test/");

    expect((await json(response)).routines[0].lastRun).toBeNull();
  });

  test("an open run stays an object with a null status, never collapsed to null", async () => {
    const store = fakeStore({
      listFor: async () => [
        summary({ lastRun: { status: null, finishedAt: null } }),
      ],
    });
    const response = await appFor(store).request("http://openbot.test/");

    expect((await json(response)).routines[0].lastRun).toEqual({
      status: null,
      at: null,
    });
  });

  test("a channel with no name and gone reads as gone with a null name", async () => {
    const store = fakeStore({
      listFor: async () => [
        summary({ channelName: null, channelDeleted: true }),
      ],
    });
    const response = await appFor(store).request("http://openbot.test/");

    expect((await json(response)).routines[0].channel).toEqual({
      id: "channel-1",
      name: null,
      gone: true,
    });
  });

  test("the DTO carries both display words and authoritative cron for editing", async () => {
    const store = fakeStore();
    const response = await appFor(store).request("http://openbot.test/");
    const body = await json(response);

    expect(body.routines[0].schedule).toBe("Weekdays at 09:00");
    expect(body.routines[0].cron).toBe("0 9 * * 1-5");
    expect(body.routines[0].overlapPolicy).toBe("skip");
  });

  test("refuses without a session, before the store is asked", async () => {
    const store = fakeStore();
    const response = await appFor(store, denied).request(
      "http://openbot.test/",
    );

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

describe("PATCH /:id", () => {
  test("updates through the owner and audits field names without field contents", async () => {
    const updates: unknown[] = [];
    const events: AuditEventInput[] = [];
    const store = fakeStore({
      async update(ownerUserId, id, patch) {
        updates.push([ownerUserId, id, patch]);
        return {} as never;
      },
    });
    const auditStore: AuditStore = {
      insert: async (event) => {
        events.push(event);
      },
    };
    const response = await appFor(store, requireUser, { auditStore }).request(
      "http://openbot.test/routine-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instruction: "private scheduled instruction",
          cron: "30 8 * * 1-5",
          timezone: "Europe/Warsaw",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(updates).toEqual([
      [
        actor.id,
        "routine-1",
        {
          instruction: "private scheduled instruction",
          cron: "30 8 * * 1-5",
          timezone: "Europe/Warsaw",
        },
      ],
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "routine.updated",
      targetType: "routine",
      targetId: "routine-1",
      actorUserId: actor.id,
      payload: { fields: ["cron", "instruction", "timezone"] },
    });
    const auditJson = JSON.stringify(events);
    expect(auditJson).not.toContain("private scheduled instruction");
    expect(auditJson).not.toContain("30 8 * * 1-5");
    expect(auditJson).not.toContain("Europe/Warsaw");
  });

  test("rejects unknown fields before touching the store or audit", async () => {
    const store = fakeStore();
    const events: AuditEventInput[] = [];
    const response = await appFor(store, requireUser, {
      auditStore: { insert: async (event) => void events.push(event) },
    }).request("http://openbot.test/routine-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "somebody-else" }),
    });

    expect(response.status).toBe(400);
    expect(events).toEqual([]);
  });
});

describe("GET /:id/runs", () => {
  test("returns bounded safe history through an owner-scoped read", async () => {
    const calls: unknown[] = [];
    const store = fakeStore({
      async listRunsFor(ownerUserId, id, limit) {
        calls.push([ownerUserId, id, limit]);
        return [
          {
            id: "run-1",
            startedAt: new Date("2026-08-27T09:00:00.000Z"),
            finishedAt: new Date("2026-08-27T09:00:38.000Z"),
            status: "failed",
            durationMs: 38_000,
            errorSummary: "Google authorization needs to be reconnected.",
          },
        ];
      },
    });
    const response = await appFor(store).request(
      "http://openbot.test/routine-1/runs",
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([[actor.id, "routine-1", 20]]);
    expect(await json(response)).toEqual({
      runs: [
        {
          id: "run-1",
          startedAt: "2026-08-27T09:00:00.000Z",
          finishedAt: "2026-08-27T09:00:38.000Z",
          status: "failed",
          durationMs: 38_000,
          error: "Google authorization needs to be reconnected.",
        },
      ],
    });
  });
});

describe("POST /:id/run", () => {
  test("opens one owner-scoped run, audits safe metadata, and uses the routine runner", async () => {
    const opened: unknown[] = [];
    const ran: string[] = [];
    const events: AuditEventInput[] = [];
    const store = fakeStore({
      async insertManualRun(ownerUserId, id) {
        opened.push([ownerUserId, id]);
        return { runId: "run-manual-1" };
      },
    });
    const response = await appFor(store, requireUser, {
      runner: { run: async (id) => void ran.push(id) },
      auditStore: { insert: async (event) => void events.push(event) },
    }).request("http://openbot.test/routine-1/run", { method: "POST" });

    expect(response.status).toBe(202);
    expect(opened).toEqual([[actor.id, "routine-1"]]);
    expect(ran).toEqual(["run-manual-1"]);
    expect(events).toEqual([
      {
        eventType: "routine.manual_run_requested",
        targetType: "routine",
        targetId: "routine-1",
        actorUserId: actor.id,
        payload: { runId: "run-manual-1" },
      },
    ]);
  });

  test("returns conflict and starts nothing when the routine is already running", async () => {
    const ran: string[] = [];
    const events: AuditEventInput[] = [];
    const store = fakeStore({
      async insertManualRun() {
        throw new RoutineOverlapError();
      },
    });
    const response = await appFor(store, requireUser, {
      runner: { run: async (id) => void ran.push(id) },
      auditStore: { insert: async (event) => void events.push(event) },
    }).request("http://openbot.test/routine-1/run", { method: "POST" });

    expect(response.status).toBe(409);
    expect(ran).toEqual([]);
    expect(events).toEqual([]);
  });

  test("authentication runs before an owner or runner can be touched", async () => {
    const opened: string[] = [];
    const ran: string[] = [];
    const store = fakeStore({
      async insertManualRun() {
        opened.push("opened");
        return { runId: "run-1" };
      },
    });
    const response = await appFor(store, denied, {
      runner: { run: async (id) => void ran.push(id) },
    }).request("http://openbot.test/routine-1/run", { method: "POST" });

    expect(response.status).toBe(401);
    expect(opened).toEqual([]);
    expect(ran).toEqual([]);
  });
});

describe("PUT /:id/enabled", () => {
  test("switches a routine on or off through the authenticated actor", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/routine-1/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ enabled: false });
    expect(store.calls).toEqual([["setEnabled", actor.id, "routine-1", false]]);
  });

  test.each([
    ["{", "enabled must be true or false."],
    [JSON.stringify({}), "enabled must be true or false."],
    [JSON.stringify({ enabled: "yes" }), "enabled must be true or false."],
    [JSON.stringify({ enabled: 1 }), "enabled must be true or false."],
  ])("rejects a malformed body: %p", async (body, error) => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/routine-1/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      },
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error });
    expect(store.calls).toEqual([]);
  });

  test("another owner's routine reads exactly like one that does not exist", async () => {
    const store = fakeStore({
      setEnabled: async () => {
        throw new RoutineNotFoundError();
      },
    });
    const missingStore = fakeStore({
      setEnabled: async () => {
        throw new RoutineNotFoundError();
      },
    });

    const notMine = await appFor(store).request(
      "http://openbot.test/somebody-elses-routine/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    const missing = await appFor(missingStore).request(
      "http://openbot.test/no-such-routine/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    const notMineBody = await json(notMine);
    expect(notMineBody).toEqual(await json(missing));
    expect(notMineBody).toEqual({ error: "That routine does not exist." });
  });

  test("carries a store refusal's sentence verbatim as a 400", async () => {
    const store = fakeStore({
      setEnabled: async () => {
        throw new RoutineRefusedError(
          "You already have 20 routines switched on. Switch one off before adding another.",
        );
      },
    });
    const response = await appFor(store).request(
      "http://openbot.test/routine-1/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error:
        "You already have 20 routines switched on. Switch one off before adding another.",
    });
  });

  test("refuses without a session, before the store is asked", async () => {
    const store = fakeStore();
    const response = await appFor(store, denied).request(
      "http://openbot.test/routine-1/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

describe("DELETE /:id", () => {
  test("stops a routine through the authenticated actor", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/routine-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["remove", actor.id, "routine-1"]]);
  });

  test("another owner's routine reads exactly like one that does not exist", async () => {
    const notMineStore = fakeStore({
      remove: async () => {
        throw new RoutineNotFoundError();
      },
    });
    const missingStore = fakeStore({
      remove: async () => {
        throw new RoutineNotFoundError();
      },
    });

    const notMine = await appFor(notMineStore).request(
      "http://openbot.test/somebody-elses-routine",
      { method: "DELETE" },
    );
    const missing = await appFor(missingStore).request(
      "http://openbot.test/no-such-routine",
      { method: "DELETE" },
    );

    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    const notMineBody = await json(notMine);
    expect(notMineBody).toEqual(await json(missing));
    expect(notMineBody).toEqual({ error: "That routine does not exist." });
  });

  test("refuses without a session, before the store is asked", async () => {
    const store = fakeStore();
    const response = await appFor(store, denied).request(
      "http://openbot.test/routine-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });
});
