import { expect, test } from "bun:test";
import type { RoutineStore } from "../src/routines/store";
import {
  dispatchClaimedRoutines,
  offerQueuedRoutines,
} from "../src/routines/sweep";
import type { WorkQueue } from "../src/work/queue";

test("a scheduled overlap is finished as skipped without dispatching a second turn", async () => {
  const finished: string[] = [];
  const dispatched: string[] = [];
  const queue = {
    claim: async () => [
      {
        kind: "routine.fire",
        key: "routine-1:2026-08-31T09:00Z",
        payload: {
          routineId: "routine-1",
          scheduledFor: "2026-08-31T09:00:00.000Z",
        },
        attempts: 1,
      },
    ],
    renew: async () => true,
    finish: async ({ key }: { key: string }) => {
      finished.push(key);
      return true;
    },
  } as WorkQueue;
  const routineStore = {
    reapAbandonedRuns: async () => 0,
    routineForFiring: async () => ({ id: "routine-1", enabled: true }),
    insertRun: async () => ({ runId: "run-skipped", skipped: true }),
  } as RoutineStore;

  const report = await dispatchClaimedRoutines({
    queue,
    routineStore,
    owner: "worker-1",
    now: () => new Date("2026-08-31T09:01:00.000Z"),
    dispatch: async (runId) => {
      dispatched.push(runId);
    },
  });

  expect(dispatched).toEqual([]);
  expect(finished).toEqual(["routine-1:2026-08-31T09:00Z"]);
  expect(report).toEqual({
    considered: 1,
    fired: [],
    skipped: [
      { routineId: "routine-1", reason: "the previous run was still active" },
    ],
  });
});

test("queue_one finishes the colliding occurrence after its durable reservation is made", async () => {
  const finished: string[] = [];
  const dispatched: string[] = [];
  const queue = {
    claim: async () => [
      {
        kind: "routine.fire",
        key: "routine-1:2026-08-31T09:00Z",
        payload: {
          routineId: "routine-1",
          scheduledFor: "2026-08-31T09:00:00.000Z",
        },
        attempts: 1,
      },
    ],
    renew: async () => true,
    finish: async ({ key }: { key: string }) => {
      finished.push(key);
      return true;
    },
  } as WorkQueue;
  const routineStore = {
    reapAbandonedRuns: async () => 0,
    routineForFiring: async () => ({ id: "routine-1", enabled: true }),
    insertRun: async () => ({ runId: "reservation", queued: true }),
  } as RoutineStore;

  const report = await dispatchClaimedRoutines({
    queue,
    routineStore,
    owner: "worker-1",
    now: () => new Date("2026-08-31T09:01:00.000Z"),
    dispatch: async (runId) => void dispatched.push(runId),
  });

  expect(dispatched).toEqual([]);
  expect(finished).toEqual(["routine-1:2026-08-31T09:00Z"]);
  expect(report.skipped[0]?.reason).toBe(
    "one run was queued behind the active run",
  );
});

test("a ready queue_one reservation is offered under one derived idempotent key", async () => {
  const offers: unknown[] = [];
  const queue = {
    offer: async (item: unknown) => {
      offers.push(item);
      return "queued" as const;
    },
  } as WorkQueue;
  const routineStore = {
    queuedRoutines: async () => [
      {
        id: "routine-1",
        firingKey: "routine-1:2026-08-31T09:00Z",
        scheduledFor: new Date("2026-08-31T09:00:00.000Z"),
      },
    ],
  } as RoutineStore;

  expect(
    await offerQueuedRoutines({
      queue,
      routineStore,
      owner: "worker-1",
      dispatch: async () => {},
    }),
  ).toEqual({ offered: ["routine-1"] });
  expect(offers).toEqual([
    {
      kind: "routine.fire",
      key: "queue-one:routine-1:2026-08-31T09:00Z",
      payload: {
        routineId: "routine-1",
        scheduledFor: "2026-08-31T09:00:00.000Z",
        queuedSourceKey: "routine-1:2026-08-31T09:00Z",
      },
    },
  ]);
});

test("a retry whose firing identity already opened is finished without a second dispatch", async () => {
  const finished: string[] = [];
  const dispatched: string[] = [];
  const queue = {
    claim: async () => [
      {
        kind: "routine.fire",
        key: "queue-one:routine-1:2026-08-31T09:00Z",
        payload: {
          routineId: "routine-1",
          scheduledFor: "2026-08-31T09:00:00.000Z",
          queuedSourceKey: "routine-1:2026-08-31T09:00Z",
        },
        attempts: 2,
      },
    ],
    renew: async () => true,
    finish: async ({ key }: { key: string }) => {
      finished.push(key);
      return true;
    },
  } as WorkQueue;
  const routineStore = {
    reapAbandonedRuns: async () => 0,
    routineForFiring: async () => ({ id: "routine-1", enabled: true }),
    insertRun: async () => ({ runId: "run-1", duplicate: true }),
  } as RoutineStore;

  const report = await dispatchClaimedRoutines({
    queue,
    routineStore,
    owner: "worker-1",
    now: () => new Date("2026-08-31T09:30:00.000Z"),
    dispatch: async (runId) => void dispatched.push(runId),
  });

  expect(dispatched).toEqual([]);
  expect(finished).toEqual(["queue-one:routine-1:2026-08-31T09:00Z"]);
  expect(report.skipped[0]?.reason).toBe("this firing was already opened");
});
