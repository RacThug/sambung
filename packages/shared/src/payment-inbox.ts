/**
 * The paid-but-lapsed payment inbox contract (#120, ADR-0022) - the owner's
 * reconciliation surface for the late-settlement case boss fight #4 handles
 * safely but silently (ADR-0018).
 *
 * When a guest settles AFTER their hold has lapsed (swept to `expired`) or been
 * cancelled, the webhook records the `payment` as `paid` but never resurrects the
 * booking - so money is captured for a stay that no longer holds its dates. This
 * surface lets the owner SEE those and mark each handled (refund/re-accommodate is
 * a manual, offline act at sandbox - ADR-0011).
 *
 * Shared by api (frames the rows, validates the id) and web (the inbox page reads
 * `LapsedPayment` and posts the handle action).
 */
import { z } from "zod";
import { bookingStatusSchema } from "./booking";
import { paymentProviderSchema } from "./payment";
import { rupiahSchema } from "./money";

/**
 * One paid-but-lapsed payment, with enough for the owner to act (the AC): the
 * amount captured, who paid (guest + contact, owner disclosure - the opposite of
 * the public clip), the dates the money was for, and where. `bookingStatus` is the
 * full enum but is only ever `expired` | `cancelled` here (the list's predicate);
 * it tells the owner WHY the booking no longer holds. `provider` names which
 * gateway captured it. `createdAt` is the payment row's creation time (checkout),
 * for recency. Money crosses the boundary as a JSON number via `toRupiah`
 * (invariant #6).
 */
export const lapsedPaymentSchema = z.object({
  paymentId: z.string().uuid(),
  bookingId: z.string().uuid(),
  bookingStatus: bookingStatusSchema,
  provider: paymentProviderSchema,
  amountIdr: rupiahSchema,
  guestName: z.string().nullable(),
  guestPhone: z.string().nullable(),
  guestEmail: z.string().nullable(),
  checkIn: z.string().date(),
  checkOut: z.string().date(),
  propertyName: z.string(),
  unitName: z.string(),
  createdAt: z.string(), // ISO-8601 UTC
});
export type LapsedPayment = z.infer<typeof lapsedPaymentSchema>;

/**
 * The 200 for `POST /payments/:id/handle`. Echoes the id and WHEN it was marked
 * handled. Idempotent: handling an already-handled item returns its existing
 * `handledAt` rather than erroring, so a double-click or a stale list is benign.
 * There is no ledger field here - handling touches ONLY `payment.handled_at`,
 * never `payment.status` or the booking (ADR-0002).
 */
export const markPaymentHandledResponseSchema = z.object({
  paymentId: z.string().uuid(),
  handledAt: z.string(), // ISO-8601 UTC
});
export type MarkPaymentHandledResponse = z.infer<
  typeof markPaymentHandledResponseSchema
>;
