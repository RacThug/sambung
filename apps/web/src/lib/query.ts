import { QueryClient } from "@tanstack/react-query";

// Server state lives in React Query, not a global store. (architecture.md §4.3)
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});
