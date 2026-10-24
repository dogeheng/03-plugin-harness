import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ApiError } from "./lib/api.ts";
import { startEventStream } from "./lib/events.ts";
import { applyThemeClass, useTheme } from "./lib/theme.ts";
import { router } from "./router.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // 4xx answers are definitive (not found, unauthorized, invalid) — don't hammer the daemon.
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

applyThemeClass(useTheme.getState().theme);
useTheme.subscribe((s) => applyThemeClass(s.theme));
startEventStream(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
