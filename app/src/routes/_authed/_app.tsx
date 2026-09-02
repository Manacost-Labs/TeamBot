import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { MobileSidebarHeader } from "@/components/layout/mobile-sidebar-header";
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
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const currentUserId = currentUser?.id;
  useEffect(() => {
    if (currentUserId) setAgentRunSessionScope(currentUserId);
  }, [currentUserId]);

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
      <AppSidebar />
      <main className={WORKSPACE_MAIN_CLASS}>
        <MobileSidebarHeader title={appConfig.brand.productName} />
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
