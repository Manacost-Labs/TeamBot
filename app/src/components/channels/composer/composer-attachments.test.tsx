import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { Composer } from "./composer";

GlobalRegistrator.register();
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

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

describe("Composer attachments", () => {
  test("accepts multiple files and sends an attachment-only draft", async () => {
    const uploads: string[] = [];
    const receivedTexts: string[] = [];
    let receivedCount = 0;
    const view = render(
      <Composer
        compact
        attachmentUploader={async (_channelId, file) => {
          uploads.push(file.name);
          return {
            id: `id-${file.name}`,
            filename: file.name,
            mimeType: file.type || "text/plain",
            size: file.size,
          };
        }}
        onSubmit={async (draft, attachments) => {
          receivedTexts.push(draft.text);
          receivedCount = attachments.count;
          await attachments.upload("channel-1");
        }}
      />,
    );
    const input = view.getByLabelText("Добавить файлы") as HTMLInputElement;

    expect(input.multiple).toBe(true);
    fireEvent.change(input, {
      target: {
        files: [
          new File(["a"], "a.txt", { type: "text/plain" }),
          new File(["b"], "b.pdf", { type: "application/pdf" }),
        ],
      },
    });
    fireEvent.click(view.getByRole("button", { name: "Отправить сообщение" }));

    await waitFor(() => expect(uploads).toEqual(["a.txt", "b.pdf"]));
    expect(receivedTexts).toEqual([""]);
    expect(receivedCount).toBe(2);
    await waitFor(() =>
      expect(view.queryByLabelText("Вложения к сообщению")).toBeNull(),
    );
  });

  test("accepts dropped and pasted files but refuses file drafts while the Bot is busy", () => {
    const view = render(<Composer compact onSubmit={() => {}} />);
    const form = view.getByTestId("composer-form");

    fireEvent.drop(form, {
      dataTransfer: {
        files: [new File(["drop"], "drop.md", { type: "text/markdown" })],
      },
    });
    fireEvent.paste(form, {
      clipboardData: {
        files: [new File(["paste"], "paste.png", { type: "image/png" })],
      },
    });
    expect(view.getByText("drop.md")).toBeTruthy();
    expect(view.getByText("paste.png")).toBeTruthy();

    view.rerender(<Composer compact pending onSubmit={() => {}} />);
    expect(
      (view.getByLabelText("Добавить файлы") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (
        view.getByRole("button", {
          name: "Отправить сообщение",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("commits a sent file before a long Bot run and lets the next text correction queue", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    const queued: string[] = [];
    let finishRun = () => {};
    const longRun = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    URL.createObjectURL = () => "blob:sent-preview";
    URL.revokeObjectURL = (url) => revoked.push(url);

    try {
      const view = render(
        <Composer
          compact
          attachmentUploader={async (_channelId, input) => ({
            id: `id-${input.name}`,
            filename: input.name,
            mimeType: input.type,
            size: input.size,
          })}
          onQueue={(draft) => queued.push(draft.text)}
          onSubmit={async (_draft, attachments) => {
            await attachments.upload("channel-1");
            (
              attachments as typeof attachments & { commit?: () => void }
            ).commit?.();
            (
              attachments as typeof attachments & { commit?: () => void }
            ).commit?.();
            await longRun;
          }}
        />,
      );
      fireEvent.change(view.getByLabelText("Добавить файлы"), {
        target: {
          files: [new File(["png"], "sent.png", { type: "image/png" })],
        },
      });
      fireEvent.click(
        view.getByRole("button", { name: "Отправить сообщение" }),
      );

      await waitFor(() =>
        expect(Boolean(view.queryByLabelText("Вложения к сообщению"))).toBe(
          false,
        ),
      );
      expect(revoked).toEqual(["blob:sent-preview"]);
      expect(
        (view.getByLabelText("Добавить файлы") as HTMLInputElement).disabled,
      ).toBe(true);
      fireEvent.drop(view.getByTestId("composer-form"), {
        dataTransfer: {
          files: [new File(["late"], "late.txt", { type: "text/plain" })],
        },
      });
      expect(view.queryByText("late.txt")).toBeNull();

      const editor = view.getByRole("textbox", { name: "Сообщение" });
      editor.textContent = "Исправьте формулировку";
      fireEvent.input(editor);
      fireEvent.click(
        await view.findByRole("button", {
          name: "Поставить сообщение в очередь",
        }),
      );

      expect(queued).toEqual(["Исправьте формулировку"]);
    } finally {
      await act(async () => {
        finishRun();
        await longRun;
      });
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test("does not delete message-owned uploads on an immediate post-commit unmount", async () => {
    const originalFetch = globalThis.fetch;
    const deleteCalls: string[] = [];
    let allowCommit = () => {};
    const commitGate = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    let committed = () => {};
    const commitDone = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let unmountAfterCommit = () => {};
    globalThis.fetch = (async (url, init) => {
      if (init?.method === "DELETE") deleteCalls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const view = render(
        <Composer
          compact
          attachmentUploader={async (_channelId, input) => ({
            id: "attachment-owned",
            filename: input.name,
            mimeType: input.type,
            size: input.size,
          })}
          onSubmit={async (_draft, attachments) => {
            await attachments.upload("channel-1");
            await commitGate;
            attachments.commit();
            unmountAfterCommit();
            committed();
          }}
        />,
      );
      unmountAfterCommit = view.unmount;
      fireEvent.change(view.getByLabelText("Добавить файлы"), {
        target: {
          files: [new File(["owned"], "owned.txt", { type: "text/plain" })],
        },
      });
      fireEvent.click(
        view.getByRole("button", { name: "Отправить сообщение" }),
      );
      await view.findByText("Готово");

      await act(async () => {
        allowCommit();
        await commitDone;
      });

      expect(deleteCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("aborts a pending upload on unmount and never completes the submit late", async () => {
    const originalFetch = globalThis.fetch;
    let finishUpload = (_attachment: {
      id: string;
      filename: string;
      mimeType: string;
      size: number;
    }) => {};
    const pendingUpload = new Promise<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
    }>((resolve) => {
      finishUpload = resolve;
    });
    let uploadSignal: AbortSignal | undefined;
    let completed = false;
    let rejected = false;
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof fetch;

    try {
      const view = render(
        <Composer
          compact
          attachmentUploader={async (_channelId, _file, signal) => {
            uploadSignal = signal;
            return pendingUpload;
          }}
          onSubmit={async (_draft, attachments) => {
            try {
              await attachments.upload("channel-1");
              completed = true;
            } catch (error) {
              rejected = true;
              throw error;
            }
          }}
        />,
      );
      fireEvent.change(view.getByLabelText("Добавить файлы"), {
        target: {
          files: [new File(["late"], "late.txt", { type: "text/plain" })],
        },
      });
      fireEvent.click(
        view.getByRole("button", { name: "Отправить сообщение" }),
      );
      await waitFor(() => expect(uploadSignal).toBeDefined());

      view.unmount();
      expect(uploadSignal?.aborted).toBe(true);
      finishUpload({
        id: "attachment-late",
        filename: "late.txt",
        mimeType: "text/plain",
        size: 4,
      });
      await waitFor(() => expect(rejected).toBe(true));

      expect(completed).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("removes a partial ready upload when its uncommitted composer unmounts", async () => {
    const originalFetch = globalThis.fetch;
    const deleteCalls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      if (init?.method === "DELETE") deleteCalls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const view = render(
        <Composer
          compact
          attachmentUploader={async (_channelId, input) => {
            if (input.name === "broken.txt") throw new Error("offline");
            return {
              id: "attachment-ready",
              filename: input.name,
              mimeType: input.type,
              size: input.size,
            };
          }}
          onSubmit={async (_draft, attachments) => {
            await attachments.upload("channel-1");
          }}
        />,
      );
      fireEvent.change(view.getByLabelText("Добавить файлы"), {
        target: {
          files: [
            new File(["ready"], "ready.txt", { type: "text/plain" }),
            new File(["broken"], "broken.txt", { type: "text/plain" }),
          ],
        },
      });
      fireEvent.click(
        view.getByRole("button", { name: "Отправить сообщение" }),
      );
      await view.findByText("Ошибка загрузки");
      expect(view.getByText("Готово")).toBeTruthy();

      view.unmount();
      await waitFor(() =>
        expect(deleteCalls).toEqual([
          "/api/channels/channel-1/attachments/attachment-ready",
        ]),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("shows an unsupported-format error instead of storing the file", () => {
    const view = render(<Composer compact onSubmit={() => {}} />);
    fireEvent.change(view.getByLabelText("Добавить файлы"), {
      target: { files: [new File(["zip"], "archive.zip")] },
    });

    expect(view.getByRole("alert").textContent).toContain("archive.zip");
    expect(view.queryByText("Готов к загрузке")).toBeNull();
  });

  test("revokes raster object URLs when the composer unmounts", () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.createObjectURL = () => "blob:screen-preview";
    URL.revokeObjectURL = (url) => revoked.push(url);

    try {
      const view = render(<Composer compact onSubmit={() => {}} />);
      fireEvent.change(view.getByLabelText("Добавить файлы"), {
        target: {
          files: [new File(["png"], "screen.png", { type: "image/png" })],
        },
      });
      expect(view.getByAltText("Предпросмотр screen.png")).toBeTruthy();

      view.unmount();
      expect(revoked).toEqual(["blob:screen-preview"]);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
