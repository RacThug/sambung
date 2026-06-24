/**
 * @sambung/shared — the FE⇄BE contract.
 *
 * Request/response types + zod schemas live here. The API validates incoming
 * data against these schemas; the web app imports the same types so a wrong
 * field name is a compile error, not a runtime surprise. One source of truth
 * for the API shape. (architecture.md §2)
 *
 * This file seeds the pattern with a couple of shared primitives. Real
 * per-feature contracts arrive with their milestones.
 */
import { z } from "zod";

export * from "./auth";

/** Booking lifecycle. Availability is derived from these rows. (db-design.md) */
export const bookingStatusSchema = z.enum([
  "pending_payment",
  "confirmed",
  "cancelled",
  "expired",
]);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

/** Where a booking originated. */
export const bookingSourceSchema = z.enum([
  "direct",
  "airbnb",
  "booking",
  "manual",
]);
export type BookingSource = z.infer<typeof bookingSourceSchema>;

/**
 * Money is integer rupiah (no float, no cents). CLAUDE.md invariant #6.
 * Branded so a raw number can't be passed where rupiah is expected.
 */
export type Rupiah = number & { readonly __brand: "Rupiah" };
export const rupiahSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((n) => n as Rupiah);

/** Health-check response shape, shared by API and any client probe. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
