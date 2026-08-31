import { expect, test } from "bun:test";
import type { RoutineStore } from "../src/routines/store";
import { dispatchClaimedRoutines } from "../src/routines/sweep";
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
