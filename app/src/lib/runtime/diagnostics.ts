export type UiErrorType = "ui-render-error" | "ui-route-error";

/** Create a support-safe correlation id without depending on a particular browser crypto API. */
export function createIncidentId(scope: "ui" | "route"): string {
  try {
    return `${scope}-${crypto.randomUUID()}`;
  } catch {
    return `${scope}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }
}

/**
 * Report only metadata that is safe to keep in a browser console or telemetry sink.
 *
 * Error messages can contain a document title, model output or a connector response, so this
 * boundary deliberately records the error name and whether a component stack exists instead.
 */
export function reportUiError(
  type: UiErrorType,
  incidentId: string,
  error: unknown,
  componentStackPresent = false,
): void {
  console.error(`[runtime] ${type}`, {
    type,
    incidentId,
    errorName: error instanceof Error ? error.name : "UnknownError",
    componentStackPresent,
  });
}
