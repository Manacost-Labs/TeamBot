import assert from "node:assert/strict";
import test from "node:test";

import { BoundedAdmission, QueueFullError } from "../src/admission.js";

test("admits two active and no more than eight queued requests", async () => {
  const gate = new BoundedAdmission({ concurrency: 2, maxQueued: 8 });
  const signal = new AbortController().signal;
  const active = [await gate.acquire(signal), await gate.acquire(signal)];
  const queued = Array.from({ length: 8 }, () => gate.acquire(signal));
  await assert.rejects(gate.acquire(signal), QueueFullError);
  active[0]();
  const firstQueued = await queued[0];
  active[1]();
  firstQueued();
  for (const waiting of queued.slice(1)) {
    const admitted = await waiting;
    admitted();
  }
});

test("removes an aborted waiter without consuming a slot", async () => {
  const gate = new BoundedAdmission({ concurrency: 1, maxQueued: 1 });
  const active = await gate.acquire(new AbortController().signal);
  const controller = new AbortController();
  const queued = gate.acquire(controller.signal);
  controller.abort(new Error("stop"));
  await assert.rejects(queued, /stop/);
  active();
  const next = await gate.acquire(new AbortController().signal);
  next();
});
