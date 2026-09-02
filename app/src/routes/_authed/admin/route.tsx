import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { MobileSidebarHeader } from "@/components/layout/mobile-sidebar-header";
import {
  WORKSPACE_MAIN_CLASS,
  WORKSPACE_PROVIDER_CLASS,
} from "@/components/layout/workspace-layout";
import { SidebarProvider } from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "../../../lib/auth/queries";

export const Route = createFileRoute("/_authed/admin")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider
      className={WORKSPACE_PROVIDER_CLASS}
      /*
       * The same 300px Settings uses: these two rails hold short nav labels, not the roster's
       * two-line previews, so they earn less width than the app shell's 340px.
       */
      style={
        {
          "--sidebar-width": "300px",
          "--sidebar-width-mobile": "20rem",
        } as React.CSSProperties
      }
    >
      <AdminSidebar />
      <main className={WORKSPACE_MAIN_CLASS}>
        <MobileSidebarHeader title="Администрирование" />
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
