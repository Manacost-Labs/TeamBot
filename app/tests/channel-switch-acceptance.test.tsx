import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ConversationView } from "../src/components/channels/conversation-view";
import { isChannelTurnBusy } from "../src/components/channels/channel-turn-activity";
import { conversationStateCache } from "../src/lib/channels/conversation-state";
import {
  type AgentRunActivityStore,
  createAgentRunActivityStore,
  useAgentRunActivity,
} from "../src/lib/copilot/run-activity-store";
import { initialAgentRunState } from "../src/lib/copilot/run-state";

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
  isRunning?: boolean;
  joined?: boolean;
  turnsInFlight?: number;
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
      busy={isChannelTurnBusy({
        isRunning: channel.isRunning ?? false,
        joined: channel.joined ?? true,
        turnsInFlight: channel.turnsInFlight ?? 0,
        run: run ?? initialAgentRunState,
      })}
      conversationKey={channel.id}
      messages={channel.messages}
      onSubmit={() => {}}
      {...(run ? { run } : {})}
    />
  );
}

describe("channel route A to B to A acceptance", () => {
  test("switching to a completed chat never mounts a transient status or orb during join", () => {
    const store = createAgentRunActivityStore();
    const a: ChannelFixture = {
      id: "idle-a",
      agentId: "researcher",
      messages: history("A", 2),
    };
    const b: ChannelFixture = {
      id: "idle-b",
      agentId: "researcher",
      messages: history("B", 2),
      isRunning: true,
      joined: false,
    };
    const token = store.begin(
      { channelId: b.id, agentId: b.agentId },
      { at: 100, logicalRunId: "old-turn" },
    );
    store.transition(
      { channelId: b.id, agentId: b.agentId },
      { type: "finished", at: 200 },
      { token },
    );
    const view = render(<RoutedConversation channel={a} store={store} />);
    for (let visit = 0; visit < 3; visit += 1) {
      view.rerender(<RoutedConversation channel={b} store={store} />);
      expect(view.getByText("B answer 1")).toBeTruthy();
      expect(view.queryByTestId("transcript-run-status")).toBeNull();
      expect(view.queryByTestId("transcript-thinking-orb")).toBeNull();
      view.rerender(
        <RoutedConversation
          channel={{ ...b, joined: true, isRunning: false }}
          store={store}
        />,
      );
      expect(view.queryByTestId("transcript-run-status")).toBeNull();
      view.rerender(<RoutedConversation channel={a} store={store} />);
    }
  });

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
