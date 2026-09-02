import { describe, expect, test } from "bun:test";
import { nextDisplayedChannel } from "./displayed-channel";
import type { AgentChannel } from "./queries";

const channel = (id: string): AgentChannel => ({
  id,
  name: `Диалог ${id}`,
  agentIds: [`agent-${id}`],
  threadId: `thread-${id}`,
  active: true,
});

describe("displayed channel handoff", () => {
  test("keeps the previous channel until the requested response is ready", () => {
    const previous = channel("first");

    expect(nextDisplayedChannel(previous, undefined, "second")).toBe(previous);
    expect(nextDisplayedChannel(previous, channel("first"), "second")).toBe(
      previous,
    );
  });

  test("accepts only a response for the current route", () => {
    const previous = channel("first");
    const next = channel("second");

    expect(nextDisplayedChannel(previous, next, "second")).toBe(next);
  });

  test("does not invent a channel before the first response", () => {
    expect(nextDisplayedChannel(undefined, undefined, "first")).toBeUndefined();
  });
});
