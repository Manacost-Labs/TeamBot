import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  hasAssistantOutputAfter,
  isProgressNote,
  monitorRunEvidence,
  monitorRunEvidenceOnce,
  RECONCILIATION_DELAYS_MS,
  reconcileRunEvidence,
  reconcileRunEvidenceOnce,
} from "./run-reconciliation";

const user = { id: "user-turn", role: "user", content: "question" } as Message;
const answer = {
  id: "assistant-turn",
  role: "assistant",
  content: "answer",
} as Message;

describe("restored run reconciliation", () => {
  test("recognises only assistant output after the matching logical turn", () => {
    expect(hasAssistantOutputAfter([answer, user], user.id)).toBe(false);
    expect(hasAssistantOutputAfter([user, answer], user.id)).toBe(true);
    expect(hasAssistantOutputAfter([user], "missing-turn")).toBe(false);
  });

  test("does not treat a progress note as the completed answer", () => {
    const progress = {
      id: "progress",
      role: "assistant",
      content: "Начинаю исследование и фиксирую план.",
    } as Message;

    expect(isProgressNote(progress.content as string)).toBe(true);
    expect(hasAssistantOutputAfter([user, progress], user.id)).toBe(false);
    const finalAnswer = {
      id: "final",
      role: "assistant",
      content: "Итоговый отчёт готов.",
    } as Message;
    expect(
      hasAssistantOutputAfter([user, progress, finalAnswer], user.id),
    ).toBe(true);
  });

  test("keeps a server-authoritative active lock active without waiting for history", async () => {
    const waits: number[] = [];
    await expect(
      reconcileRunEvidence({
        logicalRunId: user.id,
        readExecution: async () => true,
        readHistory: async () => [],
        wait: async (delay) => {
          waits.push(delay);
        },
      }),
    ).resolves.toEqual({ hasAssistantOutput: false, runtimeActive: true });
    expect(waits).toEqual([]);
  });

  test("uses the full bounded backoff before proving an inactive run failed", async () => {
    const waits: number[] = [];
    await expect(
      reconcileRunEvidence({
        logicalRunId: user.id,
        readExecution: async () => false,
        readHistory: async () => [],
        wait: async (delay) => {
          waits.push(delay);
        },
      }),
    ).resolves.toEqual({ hasAssistantOutput: false, runtimeActive: false });
    expect(waits).toEqual(RECONCILIATION_DELAYS_MS.slice(1));
  });

  test("accepts delayed durable output and does not require execution lookup to succeed", async () => {
    let histories = 0;
    await expect(
      reconcileRunEvidence({
        logicalRunId: user.id,
        readExecution: async () => {
          throw new Error("execution unavailable");
        },
        readHistory: async () => {
          histories += 1;
          return histories === 3 ? [user, answer] : [user];
        },
        wait: async () => {},
      }),
    ).resolves.toEqual({ hasAssistantOutput: true, runtimeActive: false });
  });

  test("preserves uncertainty when an authority never answers", async () => {
    await expect(
      reconcileRunEvidence({
        logicalRunId: user.id,
        readExecution: async () => {
          throw new Error("execution unavailable");
        },
        readHistory: async () => [user],
        wait: async () => {},
      }),
    ).rejects.toThrow("temporarily unavailable");
  });

  test("deduplicates concurrent reconciliation for one restored generation", async () => {
    let reads = 0;
    let release = () => {};
    const execution = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    const options = {
      logicalRunId: user.id,
      readExecution: async () => {
        reads += 1;
        return execution;
      },
      readHistory: async () => [],
      wait: async () => {},
    };

    const first = reconcileRunEvidenceOnce("user:channel:agent:1", options);
    const second = reconcileRunEvidenceOnce("user:channel:agent:1", options);
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toEqual({
      hasAssistantOutput: false,
      runtimeActive: true,
    });
    expect(reads).toBe(1);
  });

  test("monitors an active restored run until delayed durable output completes it", async () => {
    let executionReads = 0;
    const observations: Array<{
      hasAssistantOutput: boolean;
      runtimeActive: boolean;
    }> = [];
    const waits: number[] = [];

    await expect(
      monitorRunEvidence({
        logicalRunId: user.id,
        readExecution: async () => {
          executionReads += 1;
          return executionReads === 1;
        },
        readHistory: async () =>
          executionReads >= 3 ? [user, answer] : [user],
        onEvidence: (evidence) => observations.push(evidence),
        onUnavailable: () => {
          throw new Error("authority should stay available");
        },
        stillCurrent: () => true,
        pollMilliseconds: 25,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }),
    ).resolves.toEqual({ hasAssistantOutput: true, runtimeActive: false });
    expect(observations).toEqual([
      { hasAssistantOutput: false, runtimeActive: true },
      { hasAssistantOutput: true, runtimeActive: false },
    ]);
    expect(waits).toContain(25);
  });

  test("retries authority outages and deduplicates the whole monitor", async () => {
    let current = true;
    let attempts = 0;
    let unavailable = 0;
    const options = {
      logicalRunId: user.id,
      readExecution: async () => {
        attempts += 1;
        if (attempts <= RECONCILIATION_DELAYS_MS.length) {
          throw new Error("temporarily unavailable");
        }
        return false;
      },
      readHistory: async () =>
        attempts > RECONCILIATION_DELAYS_MS.length ? [user, answer] : [user],
      onEvidence: () => {
        current = false;
      },
      onUnavailable: () => {
        unavailable += 1;
      },
      stillCurrent: () => current,
      pollMilliseconds: 10,
      wait: async () => {},
    };

    const first = monitorRunEvidenceOnce(
      "monitor:user:channel:agent:1",
      options,
    );
    const second = monitorRunEvidenceOnce(
      "monitor:user:channel:agent:1",
      options,
    );
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({
      hasAssistantOutput: true,
      runtimeActive: false,
    });
    expect(unavailable).toBe(1);
  });
});
