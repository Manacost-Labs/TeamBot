import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { conversationStateCache } from "@/lib/channels/conversation-state";
import { ChatTranscript } from "./chat-transcript";

GlobalRegistrator.register();
afterEach(() => {
  cleanup();
  conversationStateCache.clear();
});
afterAll(() => GlobalRegistrator.unregister());

class ResizeObserverStub {
  disconnect() {}
  observe() {}
  unobserve() {}
}

globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
window.matchMedia = () =>
  ({
    addEventListener() {},
    addListener() {},
    dispatchEvent: () => false,
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    removeEventListener() {},
    removeListener() {},
  }) as MediaQueryList;

function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: "assistant",
    content: `Answer ${index}`,
  }));
}

describe("transcript windowing", () => {
  for (const [historySize, mountedRows] of [
    [50, 50],
    [200, 60],
    [500, 60],
  ] as const) {
    test(`mounts ${mountedRows} rows for a ${historySize}-message history`, () => {
      const renders = new Map<string, number>();
      render(
        <ChatTranscript
          messages={messages(historySize)}
          onRowRender={(id) => renders.set(id, (renders.get(id) ?? 0) + 1)}
        />,
      );

      expect(renders.size).toBe(mountedRows);
    });
  }

  test("a real text delta rerenders only the changed primitive row", () => {
    const renders = new Map<string, number>();
    const onRowRender = (id: string) =>
      renders.set(id, (renders.get(id) ?? 0) + 1);
    const initial = messages(200);
    const view = render(
      <ChatTranscript messages={initial} onRowRender={onRowRender} />,
    );

    view.rerender(
      <ChatTranscript
        busy
        messages={initial.map((message, index) =>
          index === 199
            ? ({ ...message, content: "Answer 199 delta" } as Message)
            : message,
        )}
        onRowRender={onRowRender}
      />,
    );

    expect(renders.get("message-140")).toBe(1);
    expect(renders.get("message-199")).toBe(2);
    expect(view.getByText("Answer 199 delta")).toBeTruthy();
  });

  test("never renders unmarked reasoning-role content", () => {
    const view = render(
      <ChatTranscript
        messages={[
          { id: "user", role: "user", content: "Question" },
          { id: "reasoning:raw", role: "reasoning", content: "private trace" },
        ]}
      />,
    );

    expect(view.queryByText("private trace")).toBeNull();
  });

  test("keeps at most 180 rows mounted while navigating a 500-message history", () => {
    const renders = new Map<string, number>();
    const view = render(
      <ChatTranscript
        conversationKey="long-history"
        messages={messages(500)}
        onRowRender={(id) => renders.set(id, (renders.get(id) ?? 0) + 1)}
      />,
    );
    const mountedRows = () =>
      view.container.querySelectorAll("[data-transcript-window-row]");
    const showPrevious = () =>
      view.getByRole("button", { name: /Показать предыдущие сообщения/ });

    expect(mountedRows()).toHaveLength(60);
    fireEvent.click(showPrevious());
    expect(mountedRows()).toHaveLength(120);
    fireEvent.click(showPrevious());
    expect(mountedRows()).toHaveLength(180);
    expect(renders.get("message-380")).toBe(1);

    const viewport = view.container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    const retainedAnchor = mountedRows()[0] as HTMLElement;
    let anchorMeasurement = 0;
    retainedAnchor.getBoundingClientRect = () =>
      ({
        top: anchorMeasurement++ === 0 ? 100 : 700,
      }) as DOMRect;
    if (!viewport) throw new Error("Expected transcript viewport");
    viewport.scrollTop = 300;

    fireEvent.click(showPrevious());
    expect(mountedRows()).toHaveLength(180);
    expect(viewport.scrollTop).toBe(900);
    expect(view.getByText("Answer 260")).toBeTruthy();
    expect(view.queryByText("Answer 499")).toBeNull();
    expect(renders.get("message-380")).toBe(1);

    fireEvent.click(
      view.getByRole("button", {
        name: /Вернуться к последним сообщениям/,
      }),
    );
    expect(mountedRows()).toHaveLength(60);
    expect(view.getByText("Answer 499")).toBeTruthy();
  });

  test("pins the first expanded window while new messages arrive at the live tail", () => {
    const view = render(
      <ChatTranscript
        conversationKey="pinned-history"
        messages={messages(500)}
      />,
    );

    fireEvent.click(
      view.getByRole("button", { name: /Показать предыдущие сообщения/ }),
    );
    expect(view.getByText("Answer 380")).toBeTruthy();
    expect(view.getByText("Answer 499")).toBeTruthy();

    view.rerender(
      <ChatTranscript
        conversationKey="pinned-history"
        messages={messages(501)}
      />,
    );

    expect(view.getByText("Answer 380")).toBeTruthy();
    expect(view.getByText("Answer 499")).toBeTruthy();
    expect(view.queryByText("Answer 500")).toBeNull();
    expect(
      view.getByRole("button", { name: /Вернуться к последним сообщениям/ }),
    ).toBeTruthy();
  });
});
