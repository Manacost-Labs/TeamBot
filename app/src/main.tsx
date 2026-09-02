import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RuntimeErrorBoundary } from "./components/runtime/runtime-error-boundary";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("ManacostTeam could not find the application root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <RuntimeErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} context={{ queryClient }} />
      </QueryClientProvider>
    </RuntimeErrorBoundary>
  </StrictMode>,
);
