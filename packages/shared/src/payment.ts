/**
 * Payment contract (FR-PAY-1, api-spec §6.1, ADR-0015) - the guest funnel's pay
 * step: `POST /public/bookings/:id/pay`. Shared by api (frames the response) and
 * web (reads the redirect + amount on the checkout page).
 *
 * There is NO request body: the booking id is in the path and the amount is the
 * server's (deposit % of the booking's total - never the client's). So this file
 * is a response shape and the Provider vocabulary, nothing more.
 */
import { z } from "zod";
import { rupiahSchema } from "./money";

/**
 * The payment Provider. A closed set even though there is one member today: the
 * wire says which gateway minted the session, and Xendit (db-design §4.7 names
 * it) would join here, not as a free string. Pinned to nothing in the DB - the
 * `payment.provider` column is text, because a Provider is Sambung's word for an
 * external system, not an enum the schema owns.
 */
export const paymentProviderSchema = z.enum(["midtrans"]);
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;

/**
 * The 201 for `POST /public/bookings/:id/pay` (api-spec §6.1). `redirectUrl` is
 * where the browser sends the guest to pay (the Provider-hosted page); `token` is
 * the Provider's session handle (Midtrans Snap), returned for a client that would
 * rather embed than redirect. `amountIdr` is what will be charged now - the
 * Deposit share of the booking's total, floored (ADR-0015) - and `deposit` is
 * true when that is a partial (deposit % < 100), so the UI can say "deposit" vs
 * "in full" without recomputing.
 */
export const paymentSessionResponseSchema = z.object({
  provider: paymentProviderSchema,
  token: z.string(),
  redirectUrl: z.string().url(),
  amountIdr: rupiahSchema,
  deposit: z.boolean(),
});
export type PaymentSessionResponse = z.infer<typeof paymentSessionResponseSchema>;
