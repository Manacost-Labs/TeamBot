import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "./chat-transcript";

GlobalRegistrator.register();
afterEach(cleanup);
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
});
