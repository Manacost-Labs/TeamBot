import { createRouter } from "@tanstack/react-router";
import { PageLoading } from "./components/layout/page-loading";
import type { RouterContext } from "./router-context";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  context: {} as RouterContext,
  // Route modules and the authentication check can occasionally take longer than a local frame.
  // Show an honest state quickly instead of leaving the whole application blank for a second.
  defaultPendingComponent: PageLoading,
  defaultPendingMs: 150,
  defaultPendingMinMs: 250,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
