import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type LapsedPayment,
  type MarkPaymentHandledResponse,
} from "@sambung/shared";
import { api } from "../../lib/api-client";

/** One cache key for the inbox. `handle` invalidates it so the list re-reads the
 * server truth (the handled item drops out) - the source is always the API, never
 * a client-side removal that could disagree with the server. */
const LAPSED_KEY = ["lapsed-payments"] as const;

/** The paid-but-lapsed inbox read (#120): `GET /payments/lapsed`, owner-scoped. */
export function useLapsedPayments() {
  return useQuery({
    queryKey: LAPSED_KEY,
    queryFn: () => api.get<LapsedPayment[]>("/payments/lapsed"),
  });
}

/**
 * The "mark handled" action, as a per-row hook so each row owns its own pending
 * state (a page-level mutation would spin every button at once). On success it
 * invalidates the list; on error it ALSO invalidates - a 404 means the item was
 * already handled or is gone, so refetching shows the truth rather than a stuck row.
 */
export function useMarkHandled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) =>
      api.post<MarkPaymentHandledResponse>(
        `/payments/${paymentId}/handle`,
        {},
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: LAPSED_KEY });
    },
  });
}
