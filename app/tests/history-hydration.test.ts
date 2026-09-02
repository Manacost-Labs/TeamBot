import { describe, expect, test } from "bun:test";
import {
  createHistoryHydrationGate,
  createStableHistoryHydration,
} from "../src/lib/copilot/history-hydration";

describe("authoritative history hydration gate", () => {
  test("deduplicates an in-flight refresh and releases every waiter with its history", async () => {
    const gate = createHistoryHydrationGate<string[]>();
    let finish: ((messages: string[]) => void) | undefined;
    let loads = 0;
    const load = () => {
      loads += 1;
      return new Promise<string[]>((resolve) => {
        finish = resolve;
      });
    };

    const first = gate.ensure(load);
    const second = gate.ensure(load);
    expect(loads).toBe(1);
    finish?.(["oldest", "cached-tail"]);

    await expect(first).resolves.toEqual({
      status: "ready",
      value: ["oldest", "cached-tail"],
    });
    await expect(second).resolves.toEqual({
      status: "ready",
      value: ["oldest", "cached-tail"],
    });
  });

  test("fails closed and retries the authoritative refresh on the next send", async () => {
    const gate = createHistoryHydrationGate<string[]>();
    let loads = 0;
    const load = async () => {
      loads += 1;
      if (loads === 1) throw new Error("history unavailable");
      return ["authoritative"];
    };

    const failed = await gate.ensure(load);
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.error).toEqual(new Error("history unavailable"));
    }
    await expect(gate.ensure(load)).resolves.toEqual({
      status: "ready",
      value: ["authoritative"],
    });
    expect(loads).toBe(2);
  });

  test("does not let an obsolete refresh mark a reset gate ready", async () => {
    const gate = createHistoryHydrationGate<string[]>();
    let finish: ((messages: string[]) => void) | undefined;
    const obsolete = gate.ensure(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );

    gate.reset();
    finish?.(["wrong thread"]);
    const outcome = await obsolete;
    expect(outcome.status).toBe("failed");

    await expect(gate.ensure(async () => ["current thread"])).resolves.toEqual({
      status: "ready",
      value: ["current thread"],
    });
  });
});

describe("stable runtime target hydration", () => {
  test("explicit reset permits a fresh read for the same target", async () => {
    const target = { id: "current" };
    const hydration = createStableHistoryHydration<string, typeof target>();
    let loads = 0;

    await expect(
      hydration.ensureCurrentTarget(
        () => target,
        async () => {
          loads += 1;
          return `revision-${loads}`;
        },
      ),
    ).resolves.toMatchObject({ status: "ready", value: "revision-1" });

    hydration.reset();
    await expect(
      hydration.ensureCurrentTarget(
        () => target,
        async () => {
          loads += 1;
          return `revision-${loads}`;
        },
      ),
    ).resolves.toMatchObject({ status: "ready", value: "revision-2" });
  });

  test("rehydrates a replacement target and releases concurrent sends only to it", async () => {
    type Target = { messages: string[]; runs: number };
    const oldTarget: Target = { messages: [], runs: 0 };
    const newTarget: Target = { messages: [], runs: 0 };
    let currentTarget = oldTarget;
    let finishFirst: ((messages: string[]) => void) | undefined;
    let finishSecond: ((messages: string[]) => void) | undefined;
    let loads = 0;
    const load = () => {
      loads += 1;
      return new Promise<string[]>((resolve) => {
        if (loads === 1) finishFirst = resolve;
        else finishSecond = resolve;
      });
    };
    const hydration = createStableHistoryHydration<string[], Target>();

    const first = hydration.ensureCurrentTarget(() => currentTarget, load);
    const second = hydration.ensureCurrentTarget(() => currentTarget, load);
    expect(loads).toBe(1);

    currentTarget = newTarget;
    finishFirst?.(["obsolete"]);
    while (!finishSecond) await Promise.resolve();
    expect(loads).toBe(2);
    finishSecond(["authoritative"]);

    const outcomes = await Promise.all([first, second]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("ready");
      if (outcome.status !== "ready") continue;
      outcome.target.messages.push(...outcome.value, "new message");
      outcome.target.runs += 1;
    }

    expect(oldTarget).toEqual({ messages: [], runs: 0 });
    expect(newTarget).toEqual({
      messages: [
        "authoritative",
        "new message",
        "authoritative",
        "new message",
      ],
      runs: 2,
    });
  });
});
