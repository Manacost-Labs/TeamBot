import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { RuntimeErrorBoundary } from "./runtime-error-boundary";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  mock.restore();
});
afterAll(() => GlobalRegistrator.unregister());

describe("RuntimeErrorBoundary", () => {
  test("contains a render failure without exposing the exception text", () => {
    const report = mock((..._args: unknown[]) => undefined);
    const originalError = console.error;
    console.error = report as unknown as typeof console.error;

    function BrokenView(): ReactNode {
      throw new Error("private model response");
    }

    const view = render(
      <RuntimeErrorBoundary>
        <BrokenView />
      </RuntimeErrorBoundary>,
    );

    expect(view.getByRole("alert").textContent).toContain(
      "Приложение временно недоступно",
    );
    expect(view.getByRole("alert").textContent).not.toContain(
      "private model response",
    );
    expect(report.mock.calls.length).toBeGreaterThan(0);
    expect(
      report.mock.calls.some(
        ([message]) => message === "[runtime] ui-render-error",
      ),
    ).toBe(true);

    console.error = originalError;
  });

  test("retries the child tree without a full page reload", () => {
    const originalError = console.error;
    console.error = (() => undefined) as typeof console.error;
    let broken = true;
    function MaybeBrokenView() {
      if (broken) throw new Error("temporary");
      return <p>Рабочая область</p>;
    }

    try {
      const view = render(
        <RuntimeErrorBoundary>
          <MaybeBrokenView />
        </RuntimeErrorBoundary>,
      );

      broken = false;
      fireEvent.click(view.getByRole("button", { name: "Повторить" }));
      expect(view.getByText("Рабочая область")).toBeTruthy();
    } finally {
      console.error = originalError;
    }
  });
});
