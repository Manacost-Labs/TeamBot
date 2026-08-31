import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedRenderQueue,
  QueueFullError,
  RenderTimeoutError,
} from "../src/queue.js";

const abortableDelay = (signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 10_000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

test("runs at most two jobs and admits no more than 32 waiting jobs", async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  const releases = [];
  const queue = new BoundedRenderQueue({
    concurrency: 2,
    maxQueued: 32,
    timeoutMs: 5_000,
    run: async (_job, { signal }) => {
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve, reject) => {
          releases.push(resolve);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return Buffer.from("%PDF-job");
      } finally {
        active -= 1;
      }
    },
  });

  const accepted = Array.from({ length: 34 }, (_, id) => queue.submit({ id }));
  await assert.rejects(queue.submit({ id: 35 }), QueueFullError);
  assert.equal(peak, 2);

  while (started < 34) {
    releases.splice(0).forEach((release) => {
      release();
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  releases.splice(0).forEach((release) => {
    release();
  });
  await Promise.all(accepted);
  assert.equal(peak, 2);
});

test("times out a running job and aborts its renderer", async () => {
  let wasAborted = false;
  const queue = new BoundedRenderQueue({
    concurrency: 2,
    maxQueued: 32,
    timeoutMs: 20,
    run: async (_job, { signal }) => {
      signal.addEventListener("abort", () => {
        wasAborted = true;
      });
      await abortableDelay(signal);
    },
  });

  await assert.rejects(queue.submit({}), RenderTimeoutError);
  assert.equal(wasAborted, true);
});
