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
 * Reduce a human-typed phone to the digits `wa.me` wants: international format,
 * digits only, no `+`, spaces, or punctuation.
 *
 * Deliberately conservative - it does NOT guess a country code. A national
 * "0812..." stays "0812..." (which `wa.me` may misresolve); the guest-phone field
 * accepts a leading `+`, which is how a guest supplies the country code, so the
 * common case (`+62 812 ...`) normalizes correctly. A leading "00" international
 * access code is stripped. Returns "" when the result isn't a plausible number
 * (the E.164 8-15 digit range), so the caller can omit the link rather than emit
 * a broken one.
 */
export function normalizeWaPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
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
