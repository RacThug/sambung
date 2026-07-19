import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
// Self-hosted, bundled by Vite - no runtime font CDN (invariant #8, privacy,
// perf). Plus Jakarta Sans (UI/body) 400/600/700; Fraunces (display) 400/600.
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/600.css";
import { queryClient } from "./lib/query";
import { router } from "./router";
import { Toaster } from "@/components/ui/sonner";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
