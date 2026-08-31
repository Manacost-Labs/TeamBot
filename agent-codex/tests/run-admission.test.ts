import { describe, expect, test } from "bun:test";
import {
  RunAdmission,
  RunDrainingError,
  RunQueueAbortedError,
  RunQueueFullError,
  RunQueueTimeoutError,
} from "../src/run-admission";

describe("managed Codex run admission", () => {
  test("bounds global work and admits queued requests in FIFO order", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 2,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    const first = await admission.acquire("agent-a");
    const order: string[] = [];
    const secondPromise = admission.acquire("agent-b").then((lease) => {
      order.push("agent-b");
      return lease;
    });
    const thirdPromise = admission.acquire("agent-c").then((lease) => {
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
    const firstA = await admission.acquire("agent-a");
    let secondAStarted = false;
    const secondAPromise = admission.acquire("agent-a").then((lease) => {
      secondAStarted = true;
      return lease;
    });
    const firstB = await admission.acquire("agent-b");

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
    const active = await admission.acquire("agent-a");
    const queued = admission.acquire("agent-b");
    await expect(admission.acquire("agent-c")).rejects.toBeInstanceOf(
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
    const active = await admission.acquire("agent-a");
    await expect(admission.acquire("agent-b")).rejects.toBeInstanceOf(
      RunQueueTimeoutError,
    );

    const controller = new AbortController();
    const aborted = admission.acquire("agent-c", controller.signal);
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
    const lease = await admission.acquire("editor");
    await expect(admission.acquire("editor")).rejects.toBeInstanceOf(
      RunQueueFullError,
    );
    lease.release();

    const serialized = JSON.stringify(events);
    expect(serialized).toContain("managed-run-admission");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("credentials");
  });

  test("drains active work, rejects queued and new work, then resumes", async () => {
    const admission = new RunAdmission({
      globalLimit: 1,
      perAgentLimit: 1,
      queueLimit: 2,
      maxWaitMs: 1_000,
      sink: () => {},
    });
    const active = await admission.acquire("agent-a");
    const queued = admission.acquire("agent-b");

    expect(admission.startDraining()).toMatchObject({
      active: 1,
      queued: 0,
      draining: true,
    });
    await expect(queued).rejects.toBeInstanceOf(RunDrainingError);
    await expect(admission.acquire("agent-c")).rejects.toBeInstanceOf(
      RunDrainingError,
    );

    active.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, draining: true });
    admission.resume();
    const resumed = await admission.acquire("agent-c");
    resumed.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, draining: false });
  });
});
