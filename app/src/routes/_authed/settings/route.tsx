import { createFileRoute, Outlet } from "@tanstack/react-router";
import { MobileSidebarHeader } from "@/components/layout/mobile-sidebar-header";
import {
  WORKSPACE_MAIN_CLASS,
  WORKSPACE_PROVIDER_CLASS,
} from "@/components/layout/workspace-layout";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider
      className={WORKSPACE_PROVIDER_CLASS}
      /*
       * The same 300px admin uses: these two rails hold short nav labels, not the roster's
       * two-line previews, so they earn less width than the app shell's 340px.
       */
      style={
        {
          "--sidebar-width": "300px",
          "--sidebar-width-mobile": "20rem",
        } as React.CSSProperties
      }
    >
      <SettingsSidebar />
      <main className={WORKSPACE_MAIN_CLASS}>
        <MobileSidebarHeader title="Настройки рабочего пространства" />
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
