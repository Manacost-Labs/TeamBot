import { describe, expect, test } from "bun:test";
import { StreamTextScheduler } from "./stream-text-scheduler";

type PendingTimer = { callback: () => void; delay: number; cancelled: boolean };

function testClock() {
  let time = 0;
  const timers: PendingTimer[] = [];
  return {
    timers,
    now: () => time,
    advance(milliseconds: number) {
      time += milliseconds;
    },
    schedule(callback: () => void, delay: number) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(timer: object | number) {
      (timer as PendingTimer).cancelled = true;
    },
    runNext() {
      const timer = timers.shift();
      if (!timer || timer.cancelled) return;
      timer.callback();
    },
  };
}

describe("StreamTextScheduler", () => {
  test("flushes only the latest snapshot in one window", () => {
    const clock = testClock();
    const flushed: string[] = [];
    const scheduler = new StreamTextScheduler((value) => flushed.push(value), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    scheduler.push("H");
    scheduler.push("He");
    scheduler.push("Hello");

    expect(flushed).toEqual([]);
    expect(clock.timers).toHaveLength(1);
    clock.runNext();
    expect(flushed).toEqual(["Hello"]);
  });

  test("flushes immediately when the render deadline is reached", () => {
    const clock = testClock();
    const flushed: string[] = [];
    const scheduler = new StreamTextScheduler((value) => flushed.push(value), {
      maxRenderLagMs: 100,
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    scheduler.push("first");
    clock.runNext();
    clock.advance(100);
    scheduler.push("second");

    expect(flushed).toEqual(["first", "second"]);
  });

  test("final flush and cancellation are safe", () => {
    const clock = testClock();
    const flushed: string[] = [];
    const scheduler = new StreamTextScheduler((value) => flushed.push(value), {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    scheduler.push("complete");
    scheduler.flush();
    scheduler.flush();
    expect(flushed).toEqual(["complete"]);

    scheduler.push("discard");
    scheduler.cancelPending();
    clock.runNext();
    expect(flushed).toEqual(["complete"]);
  });
});
