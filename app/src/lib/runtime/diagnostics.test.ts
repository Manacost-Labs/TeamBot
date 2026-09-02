import { afterEach, describe, expect, mock, test } from "bun:test";
import { createIncidentId, reportUiError } from "./diagnostics";

const originalError = console.error;

afterEach(() => {
  console.error = originalError;
});

describe("runtime diagnostics", () => {
  test("creates a scoped correlation id", () => {
    expect(createIncidentId("route")).toMatch(/^route-/);
    expect(createIncidentId("ui")).toMatch(/^ui-/);
  });

  test("reports metadata without serialising the exception message", () => {
    const report = mock((..._args: unknown[]) => undefined);
    console.error = report as unknown as typeof console.error;

    reportUiError(
      "ui-route-error",
      "route-incident",
      new Error("private document title"),
    );

    expect(report).toHaveBeenCalledWith("[runtime] ui-route-error", {
      type: "ui-route-error",
      incidentId: "route-incident",
      errorName: "Error",
      componentStackPresent: false,
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      "private document title",
    );
  });
});
