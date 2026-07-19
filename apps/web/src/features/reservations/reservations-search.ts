import { z } from "zod";
import { bookingSourceSchema, bookingStatusSchema } from "@sambung/shared";

/**
 * A repeatable set-filter as it arrives from the URL. TanStack Router's default
 * parser hands us `undefined`, a bare string (`?status=confirmed`, e.g. hand-typed),
 * or an array (`?status=["a","b"]` from our own navigation) - this normalizes all
 * three to an array, the mirror of the API's `repeatable()` on the query. A value
 * that isn't a valid member degrades the whole param to `undefined` (`.catch`), the
 * funnel's "a pasted bad param must not crash the page" rule.
 */
const setParam = <T extends z.ZodTypeAny>(inner: T) =>
  z
    .preprocess(
      (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
      z.array(inner).optional(),
    )
    .catch(undefined);

/**
 * `/app/reservations` URL state (page-spec §4.2): `?from&to&propertyId&status&source`.
 * Every filter is a typed search param, AND-ed, so any filter combination is a
 * shareable URL (the AC). `status`/`source` are the same repeatable set-filters
 * `GET /bookings` takes (§5.5) - an owner filters to "confirmed OR pending" in one
 * view, which a single-valued param could not express.
 *
 * Each scalar field degrades to `undefined` on a bad value (`.catch(undefined)`),
 * so a pasted `?propertyId=oops` opens the unfiltered list rather than crashing.
 *
 * `from`/`to` are absent until the owner picks a range; absence resolves to the
 * default "upcoming" window (resolveWindow), not the calendar's current month. The
 * owner sets a range to search any span, past included (CONTEXT.md "Reservation").
 */
export const reservationsSearchSchema = z.object({
  from: z.string().date().optional().catch(undefined),
  to: z.string().date().optional().catch(undefined),
  propertyId: z.string().uuid().optional().catch(undefined),
  status: setParam(bookingStatusSchema),
  source: setParam(bookingSourceSchema),
});
export type ReservationsSearch = z.infer<typeof reservationsSearchSchema>;
