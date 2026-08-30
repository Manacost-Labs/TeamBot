import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { AttachmentDraftItem } from "./attachment-draft";
import { AttachmentTray } from "./attachment-tray";

GlobalRegistrator.register();
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function item(
  name: string,
  status: AttachmentDraftItem["status"],
  previewUrl: string | null = null,
): AttachmentDraftItem {
  return {
    localId: name,
    file: new File(["content"], name),
    previewUrl,
    status,
    attachment: null,
    uploadedChannelId: null,
    error: status === "failed" ? "Соединение прервано" : null,
  };
}

describe("AttachmentTray", () => {
  test("shows Russian upload states and raster previews only", () => {
    const view = render(
      <AttachmentTray
        items={[
          item("screen.png", "uploading", "blob:screen"),
          item("vector.svg", "ready"),
          item("report.pdf", "failed"),
        ]}
        onRemove={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(view.getByText("Загрузка…")).toBeTruthy();
    expect(view.getByText("Готово")).toBeTruthy();
    expect(view.getByText("Ошибка загрузки")).toBeTruthy();
    expect(view.container.querySelectorAll("img")).toHaveLength(1);
    expect(view.getByAltText("Предпросмотр screen.png")).toBeTruthy();
    expect(view.queryByAltText("Предпросмотр vector.svg")).toBeNull();
  });

  test("offers retry only for failures and names every remove control", () => {
    const retried: string[] = [];
    const removed: string[] = [];
    const view = render(
      <AttachmentTray
        items={[item("notes.txt", "failed"), item("ready.pdf", "ready")]}
        onRemove={(id) => removed.push(id)}
        onRetry={(id) => retried.push(id)}
      />,
    );

    fireEvent.click(
      view.getByRole("button", { name: "Повторить загрузку notes.txt" }),
    );
    fireEvent.click(view.getByRole("button", { name: "Удалить ready.pdf" }));

    expect(retried).toEqual(["notes.txt"]);
    expect(removed).toEqual(["ready.pdf"]);
    expect(
      view.queryByRole("button", { name: "Повторить загрузку ready.pdf" }),
    ).toBeNull();
  });

  test("locks retry and removal while the message is being committed", () => {
    const view = render(
      <AttachmentTray
        disabled
        items={[item("notes.txt", "failed"), item("ready.pdf", "ready")]}
        onRemove={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(
      (
        view.getByRole("button", {
          name: "Повторить загрузку notes.txt",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        view.getByRole("button", {
          name: "Удалить ready.pdf",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
