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
 * Reduce a stored **E.164** number to the digits `wa.me` wants: strip the `+` and
 * any separators, leaving the full international number (`+6281234567890` →
 * `6281234567890`).
 *
 * Correct for EVERY country by construction, because the input is already
 * unambiguous E.164 - the checkout captured the country and stored E.164 (#54), so
 * the builder no longer guesses a country from a bare national number (the bug that
 * made `0812...` normalize to an unresolvable `wa.me/0812...`). Returns "" when the
 * result isn't a plausible international number (8-15 digits), so the caller can
 * omit the link rather than emit a broken one.
 */
export function normalizeWaPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : "";
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
