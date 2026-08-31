import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ConversationView } from "../src/components/channels/conversation-view";
import { conversationStateCache } from "../src/lib/channels/conversation-state";
import {
  type AgentRunActivityStore,
  createAgentRunActivityStore,
  useAgentRunActivity,
} from "../src/lib/copilot/run-activity-store";
import { isAgentRunActive } from "../src/lib/copilot/run-state";

GlobalRegistrator.register();

class ResizeObserverStub {
  disconnect() {}
  observe() {}
  unobserve() {}
}

globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
globalThis.requestAnimationFrame = (callback) => {
  callback(0);
  return 0;
};

afterEach(() => {
  cleanup();
  conversationStateCache.clear();
});
afterAll(() => GlobalRegistrator.unregister());

type ChannelFixture = {
  id: string;
  agentId: string;
  messages: readonly Message[];
};

function history(channel: string, size: number): Message[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `${channel}-message-${index}`,
    role: "assistant" as const,
    content: `${channel} answer ${index}`,
  }));
}

/**
 * The channel route keys its chat by channel id while the authenticated app keeps one run provider.
 * This harness preserves that exact lifetime boundary without reaching a real agent or network.
 */
function RoutedConversation({
  channel,
  store,
}: {
  channel: ChannelFixture;
  store: AgentRunActivityStore;
}) {
  return <ChannelScreen channel={channel} key={channel.id} store={store} />;
}

function ChannelScreen({
  channel,
  store,
}: {
  channel: ChannelFixture;
  store: AgentRunActivityStore;
}) {
  const run = useAgentRunActivity(
    { channelId: channel.id, agentId: channel.agentId },
    store,
  )?.state;

  return (
    <ConversationView
      busy={run ? isAgentRunActive(run.status) : false}
      conversationKey={channel.id}
      messages={channel.messages}
      onSubmit={() => {}}
      {...(run ? { run } : {})}
    />
  );
}

describe("channel route A to B to A acceptance", () => {
  test("restores history, draft and scroll exactly once while the background run keeps progressing", () => {
    const store = createAgentRunActivityStore();
    const agentId = "researcher";
    const channelA: ChannelFixture = {
      id: "channel-a",
      agentId,
      messages: history("A", 501),
    };
    const channelB: ChannelFixture = {
      id: "channel-b",
      agentId,
      messages: history("B", 200),
    };
    const runA = store.begin(
      { channelId: channelA.id, agentId },
      { at: 100, logicalRunId: "A-user-turn" },
    );

    const heightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const clientDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-slot") === "message-scroller-viewport"
          ? 1_000
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-slot") === "message-scroller-viewport"
          ? 400
          : 0;
      },
    });

    try {
      const view = render(
        <RoutedConversation channel={channelA} store={store} />,
      );

      expect(view.getAllByText("A answer 500")).toHaveLength(1);
      expect(
        view.container.querySelectorAll("[data-transcript-window-row]"),
      ).toHaveLength(60);
      expect(view.queryByLabelText("Загрузка диалога")).toBeNull();
      expect(view.getByText("Отправляет запрос")).toBeTruthy();

      const editorA = view.getByRole("textbox", { name: "Сообщение" });
      editorA.textContent = "Незаконченный черновик A";
      fireEvent.input(editorA);
      const viewportA = view.container.querySelector<HTMLElement>(
        '[data-slot="message-scroller-viewport"]',
      );
      if (!viewportA) throw new Error("Expected channel A transcript viewport");
      viewportA.scrollTop = 320;
      fireEvent.scroll(viewportA);

      view.rerender(<RoutedConversation channel={channelB} store={store} />);
      expect(view.getAllByText("B answer 199")).toHaveLength(1);
      expect(view.queryByText("A answer 500")).toBeNull();
      expect(view.queryByLabelText("Загрузка диалога")).toBeNull();

      act(() => {
        store.transition(
          { channelId: channelA.id, agentId },
          { type: "tool_started", at: 200, name: "search" },
          { token: runA },
        );
      });

      view.rerender(<RoutedConversation channel={channelA} store={store} />);
      expect(view.getAllByText("A answer 500")).toHaveLength(1);
      expect(view.queryByText("B answer 199")).toBeNull();
      expect(view.queryByLabelText("Загрузка диалога")).toBeNull();
      expect(view.getByText("Выполняет инструмент")).toBeTruthy();
      expect(view.getByRole("textbox", { name: "Сообщение" }).textContent).toBe(
        "Незаконченный черновик A",
      );

      const viewportRestored = view.container.querySelector<HTMLElement>(
        '[data-slot="message-scroller-viewport"]',
      );
      expect(viewportRestored?.scrollTop).toBe(320);
      expect(conversationStateCache.peek(channelA.id)).toMatchObject({
        scrollTop: 320,
        distanceFromEnd: 280,
      });
    } finally {
      if (heightDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          heightDescriptor,
        );
      } else {
        delete (HTMLElement.prototype as { scrollHeight?: number })
          .scrollHeight;
      }
      if (clientDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientHeight",
          clientDescriptor,
        );
      } else {
        delete (HTMLElement.prototype as { clientHeight?: number })
          .clientHeight;
      }
    }
  });
});
