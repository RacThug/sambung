import { type BookingSource, type BookingStatus } from "@sambung/shared";

/**
 * Pure booking-display vocabulary (no components), shared by the badges, the
 * reservations filter chips, and the table. Kept apart from `booking-badges.tsx`
 * so that file exports only components (React Fast Refresh needs a module to be
 * all-components or no-components).
 */

/** Per-status copy. `pending_payment` reads as "Hold" - the owner's word for an
 * unpaid claim (CONTEXT.md), not the wire's enum name. */
export const STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: "Confirmed",
  pending_payment: "Hold",
  cancelled: "Cancelled",
  expired: "Expired",
};

/** Display order: the two occupying statuses first (what an owner usually wants),
 * then the freed ones. Used by the reservations status filter chips. */
export const STATUS_ORDER: BookingStatus[] = [
  "confirmed",
  "pending_payment",
  "cancelled",
  "expired",
];

/** What to call a booking in a heading or a list cell: a Block has no guest, a
 * walk-in may have none (a confirmed direct booking taken by phone). One rule, so
 * the table and the detail page title a booking identically. */
export function bookingTitle(booking: {
  source: BookingSource;
  guestName: string | null;
}): string {
  if (booking.source === "manual_block") return "Manual block";
  return booking.guestName ?? "Walk-in";
}
