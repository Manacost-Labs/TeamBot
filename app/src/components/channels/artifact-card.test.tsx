import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ArtifactResult } from "@/lib/artifacts/contract";
import { ArtifactCard } from "./artifact-card";

GlobalRegistrator.register();
const originalFetch = globalThis.fetch;
const attachmentId = "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd";
const artifact: ArtifactResult["artifact"] = {
  attachmentId,
  filename: "untrusted-history-name.md",
  mimeType: "text/markdown",
  size: 1,
  title: "Editorial report",
};

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  // Let React's scheduled passive work settle before removing Happy DOM's window globals.
  await new Promise((resolve) => setImmediate(resolve));
  GlobalRegistrator.unregister();
});

describe("artifact card", () => {
  test("displays authoritative metadata and loads Markdown preview only on request", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).endsWith("/preview")) {
        return new Response(
          "# Preview\n\n[blocked](javascript:alert(1)) and [safe](https://example.test)\n\n![tracker](https://attacker.example/track.png)",
          { headers: { "content-type": "text/markdown" } },
        );
      }
      return Response.json({
        attachment: {
          id: attachmentId,
          name: "server-report.md",
          mimeType: "text/markdown",
          size: 2048,
          messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
          source: "agent_generated",
        },
      });
    }) as unknown as typeof fetch;

    const view = render(
      <ArtifactCard
        artifact={artifact}
        channelId="channel / one"
        toolCallId="call-markdown"
      />,
    );

    await view.findByText(/server-report\.md/);
    expect(view.queryByText(/untrusted-history-name/)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(
      view
        .getByRole("link", { name: "Скачать server-report.md" })
        .getAttribute("href"),
    ).toBe(
      `/api/channels/channel%20%2F%20one/attachments/${attachmentId}/download`,
    );

    fireEvent.click(view.getByRole("button", { name: "Предпросмотр" }));
    await view.findByRole("heading", { name: "Preview" });
    expect(calls).toHaveLength(2);
    expect(view.queryByRole("link", { name: "blocked" })).toBeNull();
    expect(view.getByRole("link", { name: "safe" }).getAttribute("href")).toBe(
      "https://example.test/",
    );
    expect(view.queryByRole("img", { name: "tracker" })).toBeNull();
    expect(view.getByText("[Изображение: tracker]")).toBeTruthy();
  });

  test("renders an isolated PDF preview and an explicit new-tab action", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        attachment: {
          id: attachmentId,
          name: "server-report.pdf",
          mimeType: "application/pdf",
          size: 4096,
          messageId: "artifact:69bb8eb0-1ac8-4c67-aeca-2362e2f507ca",
          source: "agent_generated",
        },
      })) as unknown as typeof fetch;
    const view = render(
      <ArtifactCard
        artifact={artifact}
        channelId="channel-a"
        toolCallId="call-pdf"
      />,
    );
    await view.findByText(/server-report\.pdf/);

    fireEvent.click(view.getByRole("button", { name: "Предпросмотр" }));
    const frame = await view.findByTitle("Предпросмотр server-report.pdf");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBe(
      `/api/channels/channel-a/attachments/${attachmentId}/preview`,
    );
    expect(
      view
        .getByRole("link", { name: /Открыть в новой вкладке/ })
        .getAttribute("target"),
    ).toBe("_blank");
  });

  test("offers a retry without exposing links when metadata is unavailable", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const view = render(
      <ArtifactCard
        artifact={artifact}
        channelId="channel-a"
        toolCallId="call-failed"
      />,
    );

    await view.findByText("Файл сейчас недоступен");
    expect(view.queryByRole("link")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(attempts).toBe(2));
  });
});
