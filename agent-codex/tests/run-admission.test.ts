import { describe, expect, test } from "bun:test";
import {
  RunAdmission,
  RunDrainingError,
  RunQueueAbortedError,
  RunQueueFullError,
  RunQueueTimeoutError,
} from "../src/run-admission";

const ACTOR_A = `oba_${"A".repeat(43)}`;
const ACTOR_B = `oba_${"B".repeat(43)}`;
const ACTOR_C = `oba_${"C".repeat(43)}`;

describe("managed Codex run admission", () => {
  test("bounds global work and admits queued requests in FIFO order", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 2,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    const first = await admission.acquire("agent-a", ACTOR_A);
    const order: string[] = [];
    const secondPromise = admission
      .acquire("agent-b", ACTOR_B)
      .then((lease) => {
        order.push("agent-b");
        return lease;
      });
    const thirdPromise = admission.acquire("agent-c", ACTOR_C).then((lease) => {
      order.push("agent-c");
      return lease;
    });

    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 2 });
    first.release();
    const second = await secondPromise;
    expect(order).toEqual(["agent-b"]);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 });
    second.release();
    const third = await thirdPromise;
    expect(order).toEqual(["agent-b", "agent-c"]);
    third.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  test("holds a second run for one agent while another agent uses free capacity", async () => {
    const admission = new RunAdmission({
      globalLimit: 2,
      perAgentLimit: 1,
      queueLimit: 1,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    const firstA = await admission.acquire("agent-a", ACTOR_A);
    let secondAStarted = false;
    const secondAPromise = admission
      .acquire("agent-a", ACTOR_B)
      .then((lease) => {
        secondAStarted = true;
        return lease;
      });
    const firstB = await admission.acquire("agent-b", ACTOR_C);

    expect(secondAStarted).toBe(false);
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 1 });
    firstA.release();
    const secondA = await secondAPromise;
    expect(secondAStarted).toBe(true);
    firstB.release();
    secondA.release();
  });

  test("rejects overflow and releases a lease only once", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 1,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    const active = await admission.acquire("agent-a", ACTOR_A);
    const queued = admission.acquire("agent-b", ACTOR_B);
    await expect(admission.acquire("agent-c", ACTOR_C)).rejects.toBeInstanceOf(
      RunQueueFullError,
    );
    active.release();
    active.release();
    const next = await queued;
    expect(admission.snapshot().active).toBe(1);
    next.release();
    expect(admission.snapshot().active).toBe(0);
  });

  test("times out and aborts queued requests without consuming a slot", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 2,
      maxWaitMs: 10,
      sink: () => {},
    });
    const active = await admission.acquire("agent-a", ACTOR_A);
    await expect(admission.acquire("agent-b", ACTOR_B)).rejects.toBeInstanceOf(
      RunQueueTimeoutError,
    );

    const controller = new AbortController();
    const aborted = admission.acquire("agent-c", ACTOR_C, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(RunQueueAbortedError);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
    active.release();
  });

  test("emits only bounded operational metadata", async () => {
    const events: unknown[] = [];
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 0,
      maxWaitMs: 1_000,
      sink: (event) => events.push(event),
    });
    const lease = await admission.acquire("editor", ACTOR_A);
    await expect(admission.acquire("editor", ACTOR_B)).rejects.toBeInstanceOf(
      RunQueueFullError,
    );
    lease.release();

    const serialized = JSON.stringify(events);
    expect(serialized).toContain("managed-run-admission");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("credentials");
    expect(serialized).not.toContain(ACTOR_A);
    expect(serialized).not.toContain(ACTOR_B);
  });

  test("drains active work, rejects queued and new work, then resumes", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 2,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    const active = await admission.acquire("agent-a", ACTOR_A);
    const queued = admission.acquire("agent-b", ACTOR_B);

    expect(admission.startDraining()).toMatchObject({
      active: 1,
      queued: 0,
      draining: true,
    });
    await expect(queued).rejects.toBeInstanceOf(RunDrainingError);
    await expect(admission.acquire("agent-c", ACTOR_C)).rejects.toBeInstanceOf(
      RunDrainingError,
    );

    active.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, draining: true });
    admission.resume();
    const resumed = await admission.acquire("agent-c", ACTOR_C);
    resumed.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, draining: false });
  });

  test("limits one actor across agents while another actor uses free capacity", async () => {
    const admission = new RunAdmission({
      globalLimit: 2,
      perAgentLimit: 2,
      queueLimit: 2,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    const firstActorRun = await admission.acquire("agent-a", ACTOR_A);
    let secondActorRunStarted = false;
    const secondActorRunPromise = admission
      .acquire("agent-b", ACTOR_A)
      .then((lease) => {
        secondActorRunStarted = true;
        return lease;
      });
    const otherActorRun = await admission.acquire("agent-a", ACTOR_B);

    expect(secondActorRunStarted).toBe(false);
    expect(admission.snapshot()).toMatchObject({
      active: 2,
      queued: 1,
      perActorLimit: 1,
    });

    otherActorRun.release();
    await Bun.sleep(1);
    expect(secondActorRunStarted).toBe(false);
    firstActorRun.release();
    const secondActorRun = await secondActorRunPromise;
    expect(secondActorRunStarted).toBe(true);
    secondActorRun.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  test("restores actor, agent and global capacity exactly once after timeout, abort, drain and release", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 1,
      maxWaitMs: 5,
      sink: () => {},
    });
    const active = await admission.acquire("agent-a", ACTOR_A);
    await expect(admission.acquire("agent-b", ACTOR_B)).rejects.toBeInstanceOf(
      RunQueueTimeoutError,
    );

    const controller = new AbortController();
    const aborted = admission.acquire("agent-b", ACTOR_B, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(RunQueueAbortedError);

    const drained = admission.acquire("agent-b", ACTOR_B);
    admission.startDraining();
    await expect(drained).rejects.toBeInstanceOf(RunDrainingError);
    active.release();
    active.release();
    admission.resume();

    const actorAgain = await admission.acquire("agent-a", ACTOR_A);
    actorAgain.release();
    const otherAgain = await admission.acquire("agent-b", ACTOR_B);
    otherAgain.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });
});
