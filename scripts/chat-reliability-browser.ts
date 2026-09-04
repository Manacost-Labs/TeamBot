import assert from "node:assert/strict";
import type { Message } from "@ag-ui/core";
import type { Page } from "../artifact-renderer/node_modules/playwright/index.mjs";

/** Same keyed transcript across real text deltas; no provider, credentials or remote requests. */
export async function verifyChatReliability(page: Page) {
  const show = async (messages: Message[], key?: string) => {
    await page.evaluate(
      ({ messages, key }) => {
        const fixture = (
          window as typeof window & {
            runtimePerformanceBenchmark?: {
              showTranscript: (messages: Message[], key?: string) => void;
            };
          }
        ).runtimePerformanceBenchmark;
        if (!fixture) throw new Error("Transcript fixture is not ready");
        fixture.showTranscript(messages, key);
      },
      { messages, key },
    );
    // Observe an actual commit and paint, rather than only inspecting a queued state update.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  };
  const messages: Message[] = Array.from({ length: 50 }, (_, index) => ({
    id: `reliability-${index}`,
    role: "assistant",
    content: `History row ${index}`,
  }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await show(messages, "reliability-live");
  const stableRow = await page
    .getByText("History row 49", { exact: true })
    .elementHandle();
  assert(stableRow);
  messages[0] = { ...messages[0], content: "Corrected history row" } as Message;
  await show(messages);
  assert.equal(
    await page.getByText("History row 0", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("Corrected history row", { exact: true }).count(),
    1,
  );
  assert(await stableRow.evaluate((element) => element.isConnected));

  messages.push({
    id: "live-answer",
    role: "assistant",
    content: "Live delta 0",
  });
  await show(messages);
  const live = page
    .locator('[data-slot="message-arriving"]')
    .filter({ hasText: "Live delta 0" });
  const node = await live.elementHandle();
  assert(node);
  const animation = await node.evaluateHandle((element) => {
    const entrance = element.getAnimations()[0];
    if (!entrance)
      throw new Error("Live row did not get a CSS entrance animation");
    entrance.pause();
    entrance.currentTime = 80;
    return entrance;
  });
  for (let delta = 1; delta <= 12; delta += 1) {
    messages[messages.length - 1] = {
      id: "live-answer",
      role: "assistant",
      content: `Live delta ${delta}`,
    };
    await show(messages);
    assert(
      await node.evaluate(
        (element, entrance) =>
          element.isConnected && element.getAnimations()[0] === entrance,
        animation,
      ),
      "A delta replaced the live row or cancelled/restarted its animation",
    );
  }
  await animation.evaluate((entrance) => {
    entrance.currentTime = 160;
  });
  assert.equal(
    await node.evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  assert.equal(await node.textContent(), "Live delta 12");
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  // The benchmark host is content-sized. Give its viewport a fixed chat-sized area for this check.
  await viewport.evaluate((element) => {
    element.style.height = "500px";
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await viewport.hover();
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(
    () => {
      const viewport = document.querySelector(
        '[data-slot="message-scroller-viewport"]',
      );
      return (
        viewport &&
        viewport.scrollTop > 0 &&
        viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight - 100
      );
    },
    undefined,
    { timeout: 3_000 },
  );
  const scrollBefore = await viewport.evaluate((element) => element.scrollTop);
  assert(
    scrollBefore > 0,
    `Fixture must have a scrollable history: ${JSON.stringify(
      await viewport.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflow: getComputedStyle(element).overflowY,
        bodyHeight: document.body.clientHeight,
        hostHeight: document.querySelector("#root > div")?.clientHeight,
      })),
    )}`,
  );
  messages[messages.length - 1] = {
    id: "live-answer",
    role: "assistant",
    content: "Live delta after scrolling up",
  };
  await show(messages);
  assert(
    Math.abs(
      (await viewport.evaluate((element) => element.scrollTop)) - scrollBefore,
    ) <= 1,
    "Streaming pulled a reader away from older history",
  );
  assert.equal(await page.locator("[data-transcript-window-row]").count(), 51);
  await animation.dispose();
  await node.dispose();
  await stableRow.dispose();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await show(messages.slice(0, 50), "reliability-reduced-motion");
  await show([
    ...messages.slice(0, 50),
    { id: "reduced-live", role: "assistant", content: "Reduced motion answer" },
  ]);
  const reduced = page
    .locator('[data-slot="message-arriving"]')
    .filter({ hasText: "Reduced motion answer" });
  assert.equal(
    await reduced.evaluate((element) => element.getAnimations().length),
    0,
  );
  assert.equal(
    await reduced.evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  return {
    deltas: 12,
    stableRows: true,
    correctedHistory: true,
    preservedScroll: true,
    reducedMotion: true,
  };
}
