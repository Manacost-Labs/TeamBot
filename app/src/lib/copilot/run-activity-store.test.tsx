import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import {
  type AgentRunScope,
  createAgentRunActivityStore,
  useAgentRunActivity,
} from "./run-activity-store";

GlobalRegistrator.register();
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const channelA: AgentRunScope = { channelId: "channel-a", agentId: "agent" };
const channelB: AgentRunScope = { channelId: "channel-b", agentId: "agent" };

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("agent run activity store", () => {
  test("rejects run A completion after run B became current", () => {
    const store = createAgentRunActivityStore();
    const runA = store.begin(channelA, { at: 100, logicalRunId: "message-a" });
    store.transition(channelA, { type: "accepted", at: 110 }, { token: runA });

    const runB = store.begin(channelA, { at: 200, logicalRunId: "message-b" });
    expect(
      store.getCurrentTokenForInput(channelA, [{ id: "message-a" }]),
    ).toBeNull();
    expect(
      store.getCurrentTokenForInput(channelA, [{ id: "message-b" }]),
    ).toEqual(runB);
    store.transition(channelA, { type: "finished", at: 300 }, { token: runA });

    expect(store.getSnapshot(channelA)?.logicalRunId).toBe("message-b");
    expect(store.getSnapshot(channelA)?.state.status).toBe("sending");

    store.transition(channelA, { type: "finished", at: 400 }, { token: runB });
    expect(store.getSnapshot(channelA)?.state.status).toBe("completed");
  });

  test("rejects late protocol events that were assigned to an older generation", () => {
    const store = createAgentRunActivityStore();
    const runA = store.begin(channelA, { at: 100, logicalRunId: "message-a" });
    store.transition(
      channelA,
      { type: "run_started", at: 120, runId: "protocol-a" },
      { protocolRunId: "protocol-a", token: runA },
    );
    const runB = store.begin(channelA, { at: 200, logicalRunId: "message-b" });
    store.transition(
      channelA,
      { type: "run_started", at: 220, runId: "protocol-b" },
      { protocolRunId: "protocol-b", token: runB },
    );

    store.transition(
      channelA,
      { type: "failed", at: 300, error: "late failure" },
      { protocolRunId: "protocol-a" },
    );
    store.transition(
      channelA,
      { type: "tool_started", at: 310, name: "late unknown tool" },
      { protocolRunId: "never-observed-protocol" },
    );

    expect(store.getSnapshot(channelA)?.logicalRunId).toBe("message-b");
    expect(store.getSnapshot(channelA)?.state.status).toBe("thinking");
  });

  test("publishes completion after every component subscriber has unmounted", () => {
    const store = createAgentRunActivityStore();
    const token = store.begin(channelA, { at: 100, logicalRunId: "message-a" });
    const unsubscribe = store.subscribe(channelA, () => {});
    unsubscribe();

    store.transition(channelA, { type: "finished", at: 500 }, { token });

    expect(store.getSnapshot(channelA)?.state.status).toBe("completed");
    expect(store.getSnapshot(channelA)?.state.finishedAt).toBe(500);
  });

  test("hydrates only minimal user-scoped metadata and reconciles against history", () => {
    const storage = new MemoryStorage();
    const first = createAgentRunActivityStore({ storage });
    first.setSessionScope("user-a");
    const token = first.begin(channelA, { at: 100, logicalRunId: "message-a" });
    first.transition(
      channelA,
      { type: "tool_started", at: 200, name: "private-tool-name" },
      { token },
    );
    first.begin(channelB, { at: 210, logicalRunId: "message-b" });

    const refreshed = createAgentRunActivityStore({ storage });
    refreshed.setAvailability(channelA, {
      at: 300,
      channelAvailable: false,
      runtimeReady: false,
    });
    refreshed.setSessionScope("user-a");
    const hydrated = refreshed.getSnapshot(channelA);
    expect(hydrated?.needsReconciliation).toBe(true);
    expect(hydrated?.state.status).toBe("using_tool");
    expect(hydrated?.state.toolName).toBeNull();
    expect(hydrated?.state.error).toBeNull();
    expect(hydrated?.availability.channelAvailable).toBe(false);

    refreshed.reconcile(channelA, {
      at: 900,
      hasAssistantOutput: true,
      runtimeActive: false,
    });
    expect(refreshed.getSnapshot(channelA)?.state.status).toBe("completed");

    refreshed.reconcile(channelB, {
      at: 910,
      hasAssistantOutput: false,
      runtimeActive: false,
    });
    expect(refreshed.getSnapshot(channelB)?.state.status).toBe("failed");

    const otherUser = createAgentRunActivityStore({ storage });
    otherUser.setSessionScope("user-b");
    expect(otherUser.getSnapshot(channelA)).toBeNull();
  });

  test("lists restored active records and keeps unavailable evidence visibly reconnecting", () => {
    const storage = new MemoryStorage();
    const original = createAgentRunActivityStore({ storage, now: () => 100 });
    original.setSessionScope("user-a");
    original.begin(channelA, { logicalRunId: "message-a" });

    const restored = createAgentRunActivityStore({ storage, now: () => 500 });
    restored.setSessionScope("user-a");
    const token = restored.getCurrentToken(channelA) ?? undefined;
    expect(restored.getRecordsNeedingReconciliation()).toHaveLength(1);

    restored.markReconciliationPending(channelA, token);
    expect(restored.getSnapshot(channelA)).toMatchObject({
      needsReconciliation: true,
      state: { status: "reconnecting" },
    });
  });

  test("keeps an active restored generation eligible for monitoring until terminal evidence", () => {
    const storage = new MemoryStorage();
    const original = createAgentRunActivityStore({ storage, now: () => 100 });
    original.setSessionScope("user-a");
    original.begin(channelA, { logicalRunId: "message-a" });

    const restored = createAgentRunActivityStore({ storage, now: () => 500 });
    restored.setSessionScope("user-a");
    const token = restored.getCurrentToken(channelA) ?? undefined;
    restored.reconcile(channelA, {
      at: 600,
      hasAssistantOutput: false,
      runtimeActive: true,
      token,
    });

    expect(restored.getSnapshot(channelA)).toMatchObject({
      needsReconciliation: true,
      state: { status: "thinking" },
    });
    expect(restored.getRecordsNeedingReconciliation()).toHaveLength(1);

    restored.reconcile(channelA, {
      at: 700,
      hasAssistantOutput: true,
      runtimeActive: false,
      token,
    });
    expect(restored.getSnapshot(channelA)).toMatchObject({
      needsReconciliation: false,
      state: { status: "completed" },
    });
  });

  test("bounds availability-only records and protocol ownership", () => {
    const store = createAgentRunActivityStore({ maxRecords: 2 });
    store.setAvailability(channelA, {
      at: 10,
      channelAvailable: true,
      runtimeReady: true,
    });
    store.setAvailability(channelB, {
      at: 20,
      channelAvailable: true,
      runtimeReady: true,
    });
    const channelC = { channelId: "channel-c", agentId: "agent" };
    store.setAvailability(channelC, {
      at: 30,
      channelAvailable: true,
      runtimeReady: true,
    });

    expect(store.getSnapshot(channelA)).toBeNull();
    expect(store.getSnapshot(channelB)).not.toBeNull();
    expect(store.getSnapshot(channelC)).not.toBeNull();

    const token = store.begin(channelC, {
      at: 40,
      logicalRunId: "message-c",
    });
    for (let index = 0; index < 20; index += 1) {
      store.transition(
        channelC,
        { type: "run_started", at: 50 + index, runId: `protocol-${index}` },
        { token, protocolRunId: `protocol-${index}` },
      );
    }
    expect(store.getSnapshot(channelC)?.protocolRunIds).toHaveLength(12);
  });

  test("keeps availability separate from the last run result", () => {
    const store = createAgentRunActivityStore();
    const token = store.begin(channelA, { at: 100, logicalRunId: "message-a" });
    store.transition(channelA, { type: "finished", at: 500 }, { token });
    store.setAvailability(channelA, {
      at: 600,
      channelAvailable: false,
      runtimeReady: false,
    });

    const snapshot = store.getSnapshot(channelA);
    expect(snapshot?.state.status).toBe("completed");
    expect(snapshot?.availability.channelAvailable).toBe(false);
    expect(snapshot?.availability.runtimeReady).toBe(false);
  });

  test("notifies only the channel whose primitive snapshot changed", () => {
    const store = createAgentRunActivityStore();
    const renders = new Map<string, number>();

    function Status({ scope }: { scope: AgentRunScope }) {
      const record = useAgentRunActivity(scope, store);
      renders.set(scope.channelId, (renders.get(scope.channelId) ?? 0) + 1);
      return <span>{record?.state.status ?? "none"}</span>;
    }

    render(
      <>
        <Status scope={channelA} />
        <Status scope={channelB} />
      </>,
    );
    expect(renders).toEqual(
      new Map([
        ["channel-a", 1],
        ["channel-b", 1],
      ]),
    );

    act(() => {
      store.begin(channelA, { at: 100, logicalRunId: "message-a" });
    });

    expect(renders.get("channel-a")).toBe(2);
    expect(renders.get("channel-b")).toBe(1);
  });
});
