import { describe, expect, test } from "bun:test";
import type { ChannelSummary } from "@/lib/channels/queries";
import { HOME_QUICK_ACTIONS, recentChannels } from "./index";

describe("ManacostTeam home navigation", () => {
  test("keeps the primary actions in a stable, useful order", () => {
    expect(HOME_QUICK_ACTIONS.map(({ to, title }) => ({ to, title }))).toEqual([
      { to: "/channel/new", title: "Новый диалог" },
      { to: "/agents", title: "Сотрудники" },
      { to: "/routines", title: "Расписание" },
      { to: "/results", title: "Результаты" },
      { to: "/settings", title: "Настройки" },
    ]);
  });

  test("shows only the three most recent conversations with activity", () => {
    const channels = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      name: `Диалог ${index}`,
      agentIds: [],
      threadId: `thread-${index}`,
      active: true,
      lastMessage: index === 3 ? null : `Сообщение ${index}`,
      lastMessageAt: index === 3 ? null : `2026-09-0${index + 1}T00:00:00.000Z`,
      lastMessageAgentId: index === 3 ? null : "agent",
      createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      pinned: false,
      lastReadAt: null,
    })) satisfies ChannelSummary[];

    expect(recentChannels(channels).map((channel) => channel.id)).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(recentChannels(undefined)).toEqual([]);
  });
});
