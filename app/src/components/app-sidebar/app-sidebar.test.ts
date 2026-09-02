import { describe, expect, test } from "bun:test";
import type { ChannelSummary } from "@/lib/channels/queries";
import { matchingChannels } from "./app-sidebar";

function channel(
  id: string,
  name: string,
  lastMessage: string,
): ChannelSummary {
  return {
    id,
    name,
    agentIds: [],
    threadId: `thread-${id}`,
    active: true,
    lastMessage,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
}

const channels = [
  channel("alpha", "Контроль данных", "Проверка источников"),
  channel("beta", "YouTube-аналитик", "Конспект готов"),
];

describe("sidebar channel filtering", () => {
  test("keeps the existing list object when there is no search query", () => {
    expect(matchingChannels(channels, "")).toBe(channels);
    expect(matchingChannels(channels, "   ")).toBe(channels);
  });

  test("matches the visible name and preview text", () => {
    expect(
      matchingChannels(channels, "youtube").map((item) => item.id),
    ).toEqual(["beta"]);
    expect(
      matchingChannels(channels, "источников").map((item) => item.id),
    ).toEqual(["alpha"]);
  });
});
