/**
 * Shared shell geometry for every full-screen workspace surface.
 *
 * The shell owns the viewport, while the main column owns vertical scrolling. Keeping that
 * contract in one place prevents configuration pages from growing past the viewport and being
 * clipped by a sibling route's `overflow-hidden` container.
 */
export const WORKSPACE_PROVIDER_CLASS = "h-svh overflow-hidden";
export const WORKSPACE_MAIN_CLASS =
  "flex min-h-0 flex-1 flex-col overflow-y-auto";
