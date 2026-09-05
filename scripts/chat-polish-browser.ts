import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import type { isChannelTurnBusy } from "../app/src/components/channels/channel-turn-activity";
import { initialAgentRunState } from "../app/src/lib/copilot/run-state";
import type { Page } from "../artifact-renderer/node_modules/playwright/index.mjs";

type Activity = Parameters<typeof isChannelTurnBusy>[0];

/** Actual channel busy selector and transcript in Chromium; no account, agent or network needed. */
export async function verifyChatPolish(page: Page, profile: string) {
  const show = async (messages: Message[], key: string, activity: Activity) => {
    await page.evaluate(
      ({ messages, key, activity }) => {
        const fixture = (
          window as typeof window & {
            runtimePerformanceBenchmark?: {
              showTranscript: (
                messages: Message[],
                key: string,
                activity: Activity,
              ) => void;
            };
          }
        ).runtimePerformanceBenchmark;
        if (!fixture) throw new Error("Chat fixture is not ready");
        fixture.showTranscript(messages, key, activity);
      },
      { messages, key, activity },
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  };
  const idle: Activity = {
    isRunning: false,
    joined: true,
    turnsInFlight: 0,
    run: {
      ...initialAgentRunState,
      startedAt: 100,
      finishedAt: 200,
      hasAssistantOutput: true,
    },
  };
  const history: Message[] = [
    {
      id: "polish-question",
      role: "user",
      content:
        "Подготовь краткую сводку по проекту: что уже готово, что проверить дальше и где лежит документ.\n\nСохрани результат в Google Docs.",
    },
    {
      id: "polish-answer",
      role: "assistant",
      content:
        "## Сводка по проекту\n\nОсновные изменения готовы к проверке. Ниже — короткий список перед публикацией.\n\n- Проверить переключение диалогов.\n- Убедиться, что новые сообщения не сбивают прокрутку.\n- Сверить документ с последними правками.\n\n**Следующий шаг:** проверить результат на телефоне и компьютере.",
    },
  ];

  await show(history, "polish-a", idle);
  // Observe mounts, not just the final DOM: a one-frame flash must fail too.
  const flashes = await page.evaluateHandle(() => {
    const selector =
      '[data-testid="transcript-run-status"], [data-testid="transcript-thinking-orb"]';
    const tracker = { mounts: 0, observer: null as MutationObserver | null };
    tracker.observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches(selector) || node.querySelector(selector))
          )
            tracker.mounts += 1;
        }
    });
    tracker.observer.observe(document.body, { childList: true, subtree: true });
    return tracker;
  });
  for (let visit = 0; visit < 6; visit += 1) {
    const key = `polish-${visit % 2 ? "a" : "b"}`;
    await show(history, key, { ...idle, joined: false, isRunning: true });
    const before = await page
      .getByText("Сводка по проекту", { exact: true })
      .boundingBox();
    await show(history, key, idle);
    const after = await page
      .getByText("Сводка по проекту", { exact: true })
      .boundingBox();
    assert(
      before && after && Math.abs(before.y - after.y) <= 1,
      "Settling an idle join moved the answer",
    );
  }
  const transientMounts = await flashes.evaluate((tracker) => {
    tracker.observer?.disconnect();
    return tracker.mounts;
  });
  await flashes.dispose();
  assert.equal(
    transientMounts,
    0,
    "Idle chat switching transiently mounted a run footer/orb",
  );

  const question = history.slice(0, 1);
  await show(question, "polish-remote", {
    ...idle,
    joined: false,
    isRunning: true,
    joinExecutionActive: true,
  });
  assert.equal(await page.getByTestId("transcript-thinking-orb").count(), 1);
  assert.notEqual(
    await page.getByTestId("transcript-run-status").innerText(),
    "Ответ готов",
  );
  await show(question, "polish-send", {
    ...idle,
    joined: false,
    turnsInFlight: 1,
  });
  assert.equal(await page.getByTestId("transcript-thinking-orb").count(), 1);
  assert.equal(
    await page.getByTestId("transcript-run-status").innerText(),
    "Аналитик работает",
  );
  const orb = await page.getByTestId("transcript-thinking-orb").elementHandle();
  assert(orb);
  await show(question, "polish-send", {
    ...idle,
    isRunning: false,
    turnsInFlight: 1,
  });
  assert(
    await orb.evaluate((element) => element.isConnected),
    "A browser handoff remounted the orb",
  );
  await show(question, "polish-send", {
    ...idle,
    joined: false,
    run: { ...idle.run, status: "reconnecting" },
  });
  assert.equal(
    await page.getByTestId("transcript-run-status").innerText(),
    "Восстанавливает соединение",
  );
  await show(history, "polish-send", idle);
  assert.equal(await page.getByTestId("transcript-thinking-orb").count(), 0);
  await orb.dispose();

  const toolHistory: Message[] = [
    ...question,
    {
      id: "polish-tool",
      role: "assistant",
      toolCalls: [
        {
          id: "polish-call",
          type: "function",
          function: {
            name: "mcp_h__oomol-connector__github_get_user__h0123456789abcdef",
            arguments: "{}",
          },
        },
      ],
    },
  ];
  await show(toolHistory, "polish-tools", { ...idle, turnsInFlight: 1 });
  assert.equal(await page.getByTestId("transcript-thinking-orb").count(), 0);
  assert.equal(await page.getByTestId("transcript-activity").count(), 1);
  toolHistory.push(
    {
      id: "polish-result",
      role: "tool",
      toolCallId: "polish-call",
      content: "Найдены материалы проекта.",
    },
    history[1],
  );

  const originalViewport = page.viewportSize();
  assert(originalViewport);
  const widths = profile === "mobile" ? [320, 390, 768] : [1440];
  const screenshotDirectory = process.env.CHAT_POLISH_SCREENSHOT_DIR;
  if (screenshotDirectory)
    await mkdir(screenshotDirectory, { recursive: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: originalViewport.height });
    for (const dark of [false, true]) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        dark,
      );
      await show(toolHistory, `polish-design-${width}-${dark}`, idle);
      const summary = page
        .getByTestId("transcript-activity")
        .locator("summary");
      await summary.focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page.getByTestId("transcript-activity").getAttribute("open"),
        "",
      );
      const summaryBounds = await summary.boundingBox();
      assert(
        summaryBounds && summaryBounds.height >= 44,
        `Activity tap target is too small: ${JSON.stringify(await summary.evaluate((element) => ({ height: element.getBoundingClientRect().height, minHeight: getComputedStyle(element).minHeight, classes: element.className })))}`,
      );
      await page.keyboard.press("Enter");
      assert.equal(
        await page.getByTestId("transcript-activity").getAttribute("open"),
        null,
      );
      // Keep keyboard focus coverage above; capture the resting design without its focus ring.
      await page.keyboard.press("Tab");
      if (screenshotDirectory)
        await page.screenshot({
          path: join(
            screenshotDirectory,
            `chat-${width}-${dark ? "dark" : "light"}.png`,
          ),
        });
      // Long unbroken user input must wrap without clipping or widening the viewport.
      await show(
        [
          {
            id: "long-input",
            role: "user",
            content: `https://example.com/${"long-path".repeat(70)}`,
          },
        ],
        "polish-long",
        idle,
      );
      assert(
        await page
          .locator('[data-slot="bubble-content"]')
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
    }
  }
  await page.setViewportSize(originalViewport);
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  return {
    idleSwitches: 6,
    transientMounts,
    handoffOrbStable: true,
    activeReconnectVisible: true,
    untrackedRemoteVisible: true,
    toolOrbSuppressed: true,
    responsiveWidths: widths,
    themes: ["light", "dark"],
    keyboardDisclosure: true,
  };
}
