import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { conversationStateCache } from "@/lib/channels/conversation-state";
import { ChatTranscript } from "./chat-transcript";

GlobalRegistrator.register();
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  conversationStateCache.clear();
  globalThis.fetch = originalFetch;
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

function PaginatedTranscriptFixture() {
  const [current, setCurrent] = useState(messages(60));
  const [hasOlder, setHasOlder] = useState(true);
  return (
    <ChatTranscript
      hasOlder={hasOlder}
      messages={current}
      onLoadOlder={async () => {
        const page = {
          hasOlder: false,
          messages: Array.from({ length: 5 }, (_, index) => ({
            id: `older-${index}`,
            role: "assistant" as const,
            content: `Older ${index}`,
          })),
          olderCursor: null,
          revision: "test-revision",
        };
        setCurrent((latest) => [...page.messages, ...latest]);
        setHasOlder(false);
        return page;
      }}
    />
  );
}

describe("transcript windowing", () => {
  test("renders aliased server tools without a frontend tool registration", () => {
    const view = render(
      <ChatTranscript
        messages={[
          {
            id: "aliased-tool",
            role: "assistant",
            toolCalls: [
              {
                id: "alias-call",
                type: "function",
                function: {
                  name: "mcp_h__oomol-connector__github_get_user__h0123456789abcdef",
                  arguments: "{}",
                },
              },
            ],
          },
        ]}
      />,
    );
    expect(view.getByText("Github get user")).toBeTruthy();
    expect(view.getByText("oomol-connector")).toBeTruthy();
  });

  test("shows the thinking orb only while the Bot is working", () => {
    const view = render(
      <ChatTranscript
        messages={[{ id: "question", role: "user", content: "Привет" }]}
      />,
    );

    expect(view.queryByTestId("transcript-thinking-orb")).toBeNull();

    view.rerender(
      <ChatTranscript
        busy
        messages={[{ id: "question", role: "user", content: "Привет" }]}
      />,
    );

    expect(view.getByTestId("transcript-thinking-orb")).toBeTruthy();
    expect(view.getByRole("img", { name: "Listening…" })).toBeTruthy();
  });

  test("renders authenticated file cards and previews raster images only", () => {
    const view = render(
      <ChatTranscript
        conversationKey="channel / one"
        messages={[
          {
            id: "files",
            role: "user",
            content: [
              {
                type: "binary",
                id: "image-1",
                mimeType: "image/png",
                filename: "screen.png",
              },
              {
                type: "binary",
                id: "svg-1",
                mimeType: "image/svg+xml",
                filename: "vector.svg",
              },
              {
                type: "binary",
                id: "pdf-1",
                mimeType: "application/pdf",
                filename: "report.pdf",
              },
            ],
          },
        ]}
      />,
    );

    expect(view.getByAltText("screen.png").getAttribute("src")).toBe(
      "/api/channels/channel%20%2F%20one/attachments/image-1/download",
    );
    expect(view.queryByAltText("vector.svg")).toBeNull();
    expect(
      view
        .getByRole("link", { name: "Скачать report.pdf" })
        .getAttribute("href"),
    ).toBe("/api/channels/channel%20%2F%20one/attachments/pdf-1/download");
  });

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

  test("reprojects nested content mutation from a stable AG-UI message array", () => {
    const content = [{ type: "text" as const, text: "First content" }];
    const stableMessages: Message[] = [
      {
        id: "mutable-user",
        role: "user",
        content,
      },
    ];
    const view = render(<ChatTranscript messages={stableMessages} />);

    expect(view.getByText("First content")).toBeTruthy();
    content[0].text = "Second content";
    view.rerender(<ChatTranscript messages={stableMessages} />);

    expect(view.queryByText("First content")).toBeNull();
    expect(view.getByText("Second content")).toBeTruthy();
  });

  test("refreshes an earlier visible row when the final two rows are unchanged", () => {
    const initial = messages(4);
    const view = render(<ChatTranscript messages={initial} />);
    const unchanged = view.getByText("Answer 3");

    view.rerender(
      <ChatTranscript
        messages={initial.map((message, index) =>
          index === 0 && message.role === "assistant"
            ? { ...message, content: "Refreshed answer" }
            : message,
        )}
      />,
    );

    expect(view.queryByText("Answer 0")).toBeNull();
    expect(view.getByText("Refreshed answer")).toBeTruthy();
    expect(view.getByText("Answer 3")).toBe(unchanged);
  });

  test("refreshes nested content outside the live edge in a stable array", () => {
    const content = [{ type: "text" as const, text: "Earlier question" }];
    const stable: Message[] = [
      { id: "earlier-user", role: "user", content },
      ...messages(3),
    ];
    const view = render(<ChatTranscript messages={stable} />);

    content[0].text = "Corrected earlier question";
    view.rerender(<ChatTranscript messages={stable} />);

    expect(view.queryByText("Earlier question")).toBeNull();
    expect(view.getByText("Corrected earlier question")).toBeTruthy();
  });

  test("keeps a live row's entrance animation across subsequent text deltas", () => {
    const initial = messages(2);
    const view = render(<ChatTranscript messages={initial} />);
    const reply: Message = {
      id: "live-answer",
      role: "assistant",
      content: "Live answer",
    };
    view.rerender(<ChatTranscript messages={[...initial, reply]} />);
    const row = view
      .getByText("Live answer")
      .closest('[data-slot="message-arriving"]');
    expect(row?.classList.contains("transcript-row-enter")).toBe(true);

    view.rerender(
      <ChatTranscript
        messages={[...initial, { ...reply, content: "Live answer continued" }]}
      />,
    );

    expect(
      view
        .getByText("Live answer continued")
        .closest('[data-slot="message-arriving"]'),
    ).toBe(row);
    expect(row?.classList.contains("transcript-row-enter")).toBe(true);
    expect(
      view
        .getByText("Answer 0")
        .closest('[data-slot="message-arriving"]')
        ?.classList.contains("transcript-row-enter"),
    ).toBe(false);
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

  test("loads and reveals an older bounded server page", async () => {
    const view = render(<PaginatedTranscriptFixture />);

    fireEvent.click(
      view.getByRole("button", { name: "Загрузить предыдущие сообщения" }),
    );

    expect(await view.findByText("Older 0")).toBeTruthy();
    expect(view.getByText("Answer 59")).toBeTruthy();
    expect(
      view.queryByRole("button", { name: /предыдущие сообщения/i }),
    ).toBeNull();
  });

  test.each([
    "mcp__artifacts__create_artifact",
    "openbot__artifacts__create_artifact",
  ])(
    "renders artifact v1 for the governed tool %s and trusts server metadata",
    async (toolName) => {
      const attachmentId = "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd";
      globalThis.fetch = (async () =>
        Response.json({
          attachment: {
            id: attachmentId,
            name: "authoritative.md",
            mimeType: "text/markdown",
            size: 73,
            messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
            source: "agent_generated",
          },
        })) as unknown as typeof fetch;
      const result = JSON.stringify({
        schema: "openbot.artifact.v1",
        artifact: {
          attachmentId,
          filename: "untrusted.md",
          mimeType: "text/markdown",
          size: 1,
          title: "Edited article",
        },
      });

      const view = render(
        <ChatTranscript
          conversationKey="channel-a"
          messages={[
            {
              id: "assistant-tool",
              role: "assistant",
              toolCalls: [
                {
                  id: "artifact-call",
                  type: "function",
                  function: {
                    name: toolName,
                    arguments: "{}",
                  },
                },
              ],
            },
            {
              id: "artifact-result",
              role: "tool",
              toolCallId: "artifact-call",
              content: result,
            },
          ]}
        />,
      );

      await view.findByText(/authoritative\.md/);
      expect(view.getByTestId("artifact-card")).toBeTruthy();
      expect(view.queryByText(/untrusted\.md/)).toBeNull();
    },
  );

  test("renders a verified artifact card from an orphaned persisted result", async () => {
    const attachmentId = "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd";
    globalThis.fetch = (async () =>
      Response.json({
        attachment: {
          id: attachmentId,
          name: "youtube-summary.md",
          mimeType: "text/markdown",
          size: 8782,
          messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
          source: "agent_generated",
        },
      })) as unknown as typeof fetch;

    const view = render(
      <ChatTranscript
        conversationKey="youtube-channel"
        messages={[
          {
            id: "artifact-result",
            role: "tool",
            toolCallId: "orphaned-artifact-call",
            content: JSON.stringify({
              schema: "openbot.artifact.v1",
              artifact: {
                attachmentId,
                filename: "youtube-summary.md",
                mimeType: "text/markdown",
                size: 8782,
                title: "Конспект YouTube-видео",
              },
            }),
          },
          {
            id: "answer",
            role: "assistant",
            content: "Успешных ссылок: 1. Недоступных: 0.",
          },
        ]}
      />,
    );

    await view.findByText("youtube-summary.md · Markdown · 8.6 КБ");
    expect(view.getByTestId("artifact-card")).toBeTruthy();
  });

  test("recovers a generated file when history lost the tool result envelope", async () => {
    const attachmentId = "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd";
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/attachments?limit=50")) {
        return Response.json({
          attachments: [
            {
              id: attachmentId,
              name: "youtube-summary.md",
              mimeType: "text/markdown",
              size: 8782,
              messageId: "artifact:export-1",
              source: "agent_generated",
            },
          ],
          nextCursor: null,
        });
      }
      return Response.json({
        attachment: {
          id: attachmentId,
          name: "youtube-summary.md",
          mimeType: "text/markdown",
          size: 8782,
          messageId: "artifact:export-1",
          source: "agent_generated",
        },
      });
    }) as unknown as typeof fetch;

    const view = render(
      <ChatTranscript
        conversationKey="youtube-channel"
        recoverArtifacts
        messages={[
          {
            id: "answer",
            role: "assistant",
            content: "Успешных ссылок: 1. Недоступных: 0.",
          },
        ]}
      />,
    );

    await view.findByText("youtube-summary.md · Markdown · 8.6 КБ");
    expect(view.getByText("Файлы этой переписки")).toBeTruthy();
    expect(requests[0]).toBe(
      "/api/channels/youtube-channel/attachments?limit=50",
    );
    expect(requests).toContain(
      "/api/channels/youtube-channel/attachments/69bb8eb0-1ac8-4c67-aeca-2362e2f507cd",
    );
  });

  test("keeps matching JSON from another tool and malformed artifact results as ordinary output", () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const envelope = JSON.stringify({
      schema: "openbot.artifact.v1",
      artifact: {
        attachmentId: "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 10,
        title: "Report",
      },
    });

    const view = render(
      <ChatTranscript
        conversationKey="channel-a"
        messages={[
          {
            id: "assistant-tools",
            role: "assistant",
            toolCalls: [
              {
                id: "foreign-call",
                type: "function",
                function: {
                  name: "mcp__other__create_artifact",
                  arguments: "{}",
                },
              },
              {
                id: "foreign-remote-call",
                type: "function",
                function: {
                  name: "openbot__other__create_artifact",
                  arguments: "{}",
                },
              },
              {
                id: "malformed-call",
                type: "function",
                function: {
                  name: "mcp__artifacts__create_artifact",
                  arguments: "{}",
                },
              },
            ],
          },
          {
            id: "foreign-result",
            role: "tool",
            toolCallId: "foreign-call",
            content: envelope,
          },
          {
            id: "malformed-result",
            role: "tool",
            toolCallId: "malformed-call",
            content: "not-json",
          },
          {
            id: "foreign-remote-result",
            role: "tool",
            toolCallId: "foreign-remote-call",
            content: envelope,
          },
        ]}
      />,
    );

    expect(view.queryByTestId("artifact-card")).toBeNull();
    expect(view.getByText("not-json")).toBeTruthy();
    expect(fetches).toBe(0);
  });

  test("renders a successful governed Google write as a safe result card", () => {
    const view = render(
      <ChatTranscript
        conversationKey="channel-a"
        messages={[
          {
            id: "assistant-google-tool",
            role: "assistant",
            toolCalls: [
              {
                id: "google-call",
                type: "function",
                function: {
                  name: "mcp__google-drive__append_google_sheet_rows",
                  arguments: "{}",
                },
              },
            ],
          },
          {
            id: "google-result",
            role: "tool",
            toolCallId: "google-call",
            content: [
              "Google Sheets",
              "",
              "[Research](https://docs.google.com/spreadsheets/d/sheet_1/edit)",
              "Research!A2:B3",
              "2 rows added · 4 cells",
              "spreadsheetId: sheet_1",
            ].join("\n"),
          },
        ]}
      />,
    );

    expect(view.getByTestId("google-workspace-card")).toBeTruthy();
    expect(view.getByText("Строки добавлены")).toBeTruthy();
    expect(view.getByText("Research!A2:B3")).toBeTruthy();
    expect(view.queryByText(/spreadsheetId/)).toBeNull();
    expect(
      view.getByRole("link", { name: "Открыть Research" }).getAttribute("href"),
    ).toBe("https://docs.google.com/spreadsheets/d/sheet_1/edit");
  });
});
