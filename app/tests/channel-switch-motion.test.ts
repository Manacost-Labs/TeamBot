import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const channelRouteSource = readFileSync(
  new URL("../src/routes/_authed/_app/channel/$channelId.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../src/components/app-sidebar/app-sidebar.tsx", import.meta.url),
  "utf8",
);

describe("channel switch motion contract", () => {
  test("does not animate the full chat surface during a channel switch", () => {
    expect(channelRouteSource).not.toContain(
      'data-testid="channel-content-transition"',
    );
    expect(channelRouteSource).not.toContain("CHANNEL_SWITCH_SECONDS");
  });

  test("keeps the channel chat remount boundary", () => {
    expect(channelRouteSource).toContain("key={channel.id}");
  });

  test("does not animate sidebar order changes during realtime updates", () => {
    expect(sidebarSource).not.toContain("animateOrder={animateOrder}");
  });
});
