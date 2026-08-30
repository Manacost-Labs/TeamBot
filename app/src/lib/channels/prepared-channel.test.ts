import { describe, expect, test } from "bun:test";
import {
  createPreparedChannelController,
  finishWithCommittedAttachments,
} from "./prepared-channel";

describe("prepared channel controller", () => {
  test("reuses the same channel after an upload failure", async () => {
    let creates = 0;
    const controller = createPreparedChannelController(async (agentId) => {
      creates += 1;
      return { id: `channel-${agentId}-${creates}` };
    });

    const first = await controller.prepare("agent-1");
    const retry = await controller.prepare("agent-1");

    expect(first).toBe(retry);
    expect(creates).toBe(1);
  });

  test("deduplicates concurrent submit attempts and separates recipients", async () => {
    let creates = 0;
    const controller = createPreparedChannelController(async (agentId) => {
      creates += 1;
      await Promise.resolve();
      return { id: `channel-${agentId}` };
    });

    const [left, right] = await Promise.all([
      controller.prepare("agent-1"),
      controller.prepare("agent-1"),
    ]);
    const other = await controller.prepare("agent-2");

    expect(left).toBe(right);
    expect(other.id).toBe("channel-agent-2");
    expect(creates).toBe(2);
  });

  test("stashes first, commits attachment ownership, then awaits navigation", async () => {
    const events: string[] = [];
    let completeNavigation = () => {};
    const navigation = new Promise<void>((resolve) => {
      completeNavigation = resolve;
    });

    const finishing = finishWithCommittedAttachments(
      async () => {
        events.push("stashed");
        await navigation;
        events.push("navigated");
      },
      () => events.push("committed"),
    );

    expect(events).toEqual(["stashed", "committed"]);
    completeNavigation();
    await finishing;
    expect(events).toEqual(["stashed", "committed", "navigated"]);
  });
});
