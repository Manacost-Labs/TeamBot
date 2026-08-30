import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep recently opened screens instant without hiding live updates: sockets and explicit
      // invalidations still refresh data immediately when something actually changes.
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
