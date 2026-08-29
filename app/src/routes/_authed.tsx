import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentUserQueryOptions } from "../lib/auth/queries";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }
  },
  // Chat mounts its runtime provider only on the three routes that use it. Keeping it out of this
  // shared boundary prevents every settings and administration page from downloading the chat,
  // generative UI and diagram renderers before it can paint.
  component: Outlet,
});
