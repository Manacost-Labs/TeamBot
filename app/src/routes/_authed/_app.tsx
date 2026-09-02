import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { MobileSidebarHeader } from "@/components/layout/mobile-sidebar-header";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import {
  WORKSPACE_MAIN_CLASS,
  WORKSPACE_PROVIDER_CLASS,
} from "@/components/layout/workspace-layout";
import { SidebarProvider } from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setAgentRunSessionScope } from "@/lib/copilot/run-activity-store";
import { appConfig } from "@/lib/generated/application-config";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const currentUserId = currentUser?.id;
  useEffect(() => {
    if (currentUserId) setAgentRunSessionScope(currentUserId);
  }, [currentUserId]);

  // Skills and automation are workspace settings, but keep their existing URLs so bookmarks and
  // links from older clients continue to work. The shell swaps only the navigation rail; the page
  // routes and their query state stay untouched.
  const settingsSurface = pathname === "/skills" || pathname === "/routines";

  return (
    <SidebarProvider
      className={WORKSPACE_PROVIDER_CLASS}
      style={
        {
          "--sidebar-width": "304px",
          "--sidebar-width-mobile": "20rem",
        } as React.CSSProperties
      }
    >
      {settingsSurface ? <SettingsSidebar /> : <AppSidebar />}
      <main className={WORKSPACE_MAIN_CLASS}>
        <MobileSidebarHeader
          title={
            settingsSurface
              ? "Настройки рабочего пространства"
              : appConfig.brand.productName
          }
        />
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
