import { describe, expect, test } from "bun:test";
import {
  type AgentRunStatus,
  initialAgentRunState,
} from "@/lib/copilot/run-state";
import { isChannelTurnBusy } from "./channel-turn-activity";

const joining = {
  isRunning: true,
  joined: false,
  turnsInFlight: 0,
  run: initialAgentRunState,
};

describe("channel turn presentation", () => {
  test("does not animate an untouched channel while connectAgent replays history", () => {
    expect(isChannelTurnBusy(joining)).toBe(false);
    expect(
      isChannelTurnBusy({ ...joining, joined: true, isRunning: false }),
    ).toBe(false);
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    test(`does not revive a ${status} run on a return visit`, () => {
      expect(
        isChannelTurnBusy({
          ...joining,
          run: { ...initialAgentRunState, startedAt: 100, status },
        }),
      ).toBe(false);
    });
  }

  test("shows a send immediately before readiness or join settles", () => {
    expect(
      isChannelTurnBusy({ ...joining, isRunning: false, turnsInFlight: 1 }),
    ).toBe(true);
  });

  test("keeps a logical turn visible between browser-tool protocol runs", () => {
    expect(
      isChannelTurnBusy({
        ...joining,
        joined: true,
        isRunning: false,
        turnsInFlight: 1,
      }),
    ).toBe(true);
  });

  for (const status of [
    "thinking",
    "using_tool",
    "generating",
    "reconnecting",
  ] satisfies AgentRunStatus[]) {
    test(`shows a tracked background ${status} run before join settles`, () => {
      expect(
        isChannelTurnBusy({
          ...joining,
          isRunning: false,
          run: { ...initialAgentRunState, startedAt: 100, status },
        }),
      ).toBe(true);
    });
  }

  test("retains the transport fallback after the initial join", () => {
    expect(isChannelTurnBusy({ ...joining, joined: true })).toBe(true);
  });

  test("shows an untracked remote run while its live connection is still joining", () => {
    expect(isChannelTurnBusy({ ...joining, joinExecutionActive: true })).toBe(
      true,
    );
    expect(isChannelTurnBusy({ ...joining, joinExecutionActive: false })).toBe(
      false,
    );
    // A late positive read must not revive an already closed connection.
    expect(
      isChannelTurnBusy({
        ...joining,
        isRunning: false,
        joinExecutionActive: true,
      }),
    ).toBe(false);
  });
});
