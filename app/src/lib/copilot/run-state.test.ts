import { describe, expect, test } from "bun:test";
import {
  formatElapsedMs,
  initialAgentRunState,
  reduceAgentRun,
} from "./run-state";

const step = (
  state: typeof initialAgentRunState,
  action: Parameters<typeof reduceAgentRun>[1],
) => reduceAgentRun(state, action);

describe("agent run state", () => {
  test("tracks a normal streaming request through completion", () => {
    let state = step(initialAgentRunState, {
      type: "send_started",
      at: 1_000,
      runId: "run-1",
    });
    state = step(state, { type: "accepted", at: 1_020 });
    state = step(state, { type: "run_initialized", at: 1_050 });
    state = step(state, { type: "run_started", at: 1_100 });
    state = step(state, { type: "text_delta", at: 2_250 });
    state = step(state, { type: "finished", at: 3_400 });

    expect(state.status).toBe("completed");
    expect(state.runId).toBe("run-1");
    expect(state.hasAssistantOutput).toBe(true);
    expect(state.elapsedMs).toBe(2_400);
    expect(state.error).toBeNull();
  });

  test("shows a tool phase and returns to thinking after the tool", () => {
    let state = step(initialAgentRunState, {
      type: "accepted",
      at: 10,
    });
    state = step(state, { type: "run_started", at: 20 });
    state = step(state, { type: "tool_started", at: 30, name: "stats-api" });
    expect(state.status).toBe("using_tool");
    expect(state.toolName).toBe("stats-api");
    state = step(state, { type: "tool_finished", at: 2_030 });
    expect(state.status).toBe("thinking");
    expect(state.toolName).toBeNull();
    expect(state.elapsedMs).toBe(2_020);
  });

  test("keeps a slow request active while elapsed time grows", () => {
    let state = step(initialAgentRunState, { type: "send_started", at: 0 });
    state = step(state, { type: "reasoning", at: 61_000 });
    expect(state.status).toBe("thinking");
    expect(state.elapsedMs).toBe(61_000);
    expect(state.finishedAt).toBeNull();
  });

  test("reconnects after a transport gap without losing progress", () => {
    let state = step(initialAgentRunState, {
      type: "run_started",
      at: 100,
    });
    state = step(state, { type: "text_delta", at: 400 });
    state = step(state, { type: "reconnecting", at: 900 });
    state = step(state, { type: "reconnected", at: 1_400 });
    expect(state.status).toBe("generating");
    expect(state.reconnectCount).toBe(1);
    expect(state.hasAssistantOutput).toBe(true);
  });

  test("reconciles a missed final event only when a persisted answer exists", () => {
    let state = step(initialAgentRunState, { type: "accepted", at: 100 });
    state = step(state, { type: "reconciled", at: 500, hasAssistantOutput: false });
    expect(state.status).toBe("accepted");
    state = step(state, { type: "reconciled", at: 1_000, hasAssistantOutput: true });
    expect(state.status).toBe("completed");
    expect(state.finishedAt).toBe(1_000);
  });

  test("keeps terminal failure and cancellation explicit", () => {
    let state = step(initialAgentRunState, { type: "send_started", at: 100 });
    state = step(state, { type: "failed", at: 900, error: "Gateway unavailable" });
    expect(state.status).toBe("failed");
    expect(state.error).toBe("Gateway unavailable");
    state = step(state, { type: "cancelled", at: 1_000 });
    expect(state.status).toBe("cancelled");
    expect(state.error).toBeNull();
  });

  test("formats elapsed time for the activity panel", () => {
    expect(formatElapsedMs(0)).toBe("0 с");
    expect(formatElapsedMs(9_999)).toBe("9 с");
    expect(formatElapsedMs(65_000)).toBe("1:05");
  });
});
