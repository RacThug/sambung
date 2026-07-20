/**
 * Confirmation-page contract (FR-PAY-1, FR-NOTIF-2, api-spec §6.3, page-spec §3.3,
 * #54) - `GET /public/bookings/:id`, the page the guest lands on after paying.
 * Shared by api (frames the response) and web (renders the live status).
 *
 * The read RECONCILES on the server (risk R3): if the booking is still pending,
 * the handler asks the Provider's status API before answering, so a lost webhook
 * still confirms here. That is a server concern; this file is only the wire shape
 * plus the pure wa.me builder both sides could reuse.
 */
import { z } from "zod";
import { bookingStatusSchema } from "./booking";
import { rupiahSchema } from "./money";

/**
 * The 200 for `GET /public/bookings/:id` (api-spec §6.3). No auth - the unguessable
 * UUID is the v1 access control, and no PII beyond what the guest themselves
 * entered rides here (no email/phone of anyone else).
 *
 * - `status` drives the page's state machine (confirmed / pending+spinner /
 *   expired / cancelled).
 * - `totalPriceIdr` is nullable only defensively (a guest booking always has a
 *   price; a manual block, which a guest can't reach, does not).
 * - `amountPaidIdr` is the sum of settled payments - the Deposit taken online.
 * - `waLink` is the prefilled `wa.me` deeplink (FR-NOTIF-2), or null when the
 *   booking carries no usable phone number.
 */
export const bookingConfirmationResponseSchema = z.object({
  status: bookingStatusSchema,
  checkIn: z.string().date(),
  checkOut: z.string().date(),
  propertyName: z.string(),
  unitName: z.string(),
  totalPriceIdr: rupiahSchema.nullable(),
  amountPaidIdr: rupiahSchema,
  waLink: z.string().url().nullable(),
});
export type BookingConfirmationResponse = z.infer<
  typeof bookingConfirmationResponseSchema
>;

/**
 * Reduce a **canonical E.164** number to the digits `wa.me` wants (`+6281234567890`
 * → `6281234567890`), or "" when the input is NOT canonical E.164.
 *
 * The gate is the point. This builder is fed ANY booking read through
 * `GET /public/bookings/:id`, including owner walk-ins whose phone uses the LENIENT
 * schema and may be a bare national number like `0812...`. Without a leading `+`
 * the country code is absent, so the number is ambiguous - stripping it would emit
 * the broken `wa.me/0812...`. Requiring canonical E.164 (the pattern mirrors
 * `e164PhoneSchema`: leading `+`, non-zero country code, 8-15 digits) makes the
 * caller OMIT the button for such a row rather than link to nowhere. The guest
 * funnel always stores `+…`, so guest links are unaffected (#123 review).
 */
export function normalizeWaPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) return "";
  return trimmed.slice(1); // drop the leading '+'; the rest is already digits-only
}

/**
 * Build the prefilled `wa.me` confirmation deeplink (FR-NOTIF-2), or null when
 * there is no usable phone number to address it to.
 *
 * v1 has no paid WhatsApp API, so the guest self-initiates by tapping the button:
 * the link opens WhatsApp to their OWN number (the one they gave as the
 * confirmation channel) with a prefilled booking summary. Because it is just a
 * server-built string, retargeting it to a stored host number later is a
 * zero-shape change.
 */
export function buildWaMeLink(input: {
  phone: string | null;
  guestName: string | null;
  propertyName: string;
  unitName: string;
  checkIn: string;
  checkOut: string;
}): string | null {
  const phone = normalizeWaPhone(input.phone);
  if (!phone) return null;
  const lines = [
    input.guestName
      ? `Hi ${input.guestName}, here's your booking:`
      : "Here's your booking:",
    `${input.propertyName} - ${input.unitName}`,
    `Check-in: ${input.checkIn}`,
    `Check-out: ${input.checkOut}`,
  ];
  return `https://wa.me/${phone}?text=${encodeURIComponent(lines.join("\n"))}`;
}
