import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";
import { ChatTranscript } from "../src/components/channels/chat-transcript";
import { conversationStateCache } from "../src/lib/channels/conversation-state";

GlobalRegistrator.register();

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

afterEach(() => {
  cleanup();
  conversationStateCache.clear();
});
afterAll(() => GlobalRegistrator.unregister());

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ControlledProgressiveAnswer({
  gates,
  observed,
}: {
  gates: readonly Deferred[];
  observed: readonly Deferred[];
}) {
  const [text, setText] = useState("");
  const messages = useMemo<readonly Message[]>(
    () => [
      { id: "question", role: "user", content: "Покажи ответ постепенно" },
      { id: "answer", role: "assistant", content: text },
    ],
    [text],
  );

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const deltas = ["дельта 1", " + дельта 2", " + дельта 3"] as const;
      for (const [index, delta] of deltas.entries()) {
        await gates[index]?.promise;
        if (!mounted) return;
        setText((current) => `${current}${delta}`);
        observed[index]?.resolve();
      }
    })();
    return () => {
      mounted = false;
    };
  }, [gates, observed]);

  return (
    <ChatTranscript
      busy
      conversationKey="progressive-stream"
      messages={messages}
    />
  );
}

describe("progressive transcript streaming", () => {
  test("shows delta 1, waits, then delta 2, waits, then delta 3 without waiting for completion", async () => {
    const gates = [deferred(), deferred(), deferred()] as const;
    const observed = [deferred(), deferred(), deferred()] as const;
    const view = render(
      <ControlledProgressiveAnswer gates={gates} observed={observed} />,
    );

    expect(view.queryByText(/дельта 1/)).toBeNull();

    await act(async () => {
      gates[0].resolve();
      await observed[0].promise;
    });
    expect(view.getByText("дельта 1")).toBeTruthy();
    expect(view.queryByText(/дельта 2/)).toBeNull();
    expect(view.queryByText(/дельта 3/)).toBeNull();

    await act(async () => {
      gates[1].resolve();
      await observed[1].promise;
    });
    expect(view.getByText("дельта 1 + дельта 2")).toBeTruthy();
    expect(view.queryByText(/дельта 3/)).toBeNull();

    await act(async () => {
      gates[2].resolve();
      await observed[2].promise;
    });
    expect(view.getByText("дельта 1 + дельта 2 + дельта 3")).toBeTruthy();
  });
});
