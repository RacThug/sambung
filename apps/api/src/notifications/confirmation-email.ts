import type { EmailMessage } from './mailer';

/** `Rp 1.200.000` from integer rupiah, for an email body. A local copy of the
 * web's formatter (the SPA's `formatIdr` can't be imported here); the id-ID locale
 * writes IDR the Indonesian way for every recipient. Money is bigint (invariant
 * #6) and only turns into a display string here. */
const rupiah = new Intl.NumberFormat('id-ID');
const formatIdr = (amount: bigint): string => `Rp ${rupiah.format(amount)}`;

/** Everything the confirmation email needs, read once on the owner connection at
 * the moment a booking is confirmed. Money is bigint (invariant #6) until the
 * renderer formats it. */
export interface ConfirmationEmailData {
  bookingId: string;
  guestName: string | null;
  guestEmail: string | null;
  ownerEmails: string[];
  propertyName: string;
  unitName: string;
  checkIn: string;
  checkOut: string;
  totalPriceIdr: bigint | null;
  amountPaidIdr: bigint;
}

/**
 * Render the confirmation emails for one confirmed booking (FR-NOTIF-1): one to
 * the guest (if they gave an email) and one to each owner of the tenant. A PURE
 * function - no I/O - so a unit test can assert recipients, subjects, and body
 * without a mailer, and NotificationsService just sends whatever this returns.
 *
 * Returns an array (possibly empty: a booking with no guest email and no owners
 * yields nothing to send), so "fire exactly once" is decided upstream by the
 * webhook's status-guarded confirm, not by anything here.
 */
export function renderConfirmationEmail(
  d: ConfirmationEmailData,
): EmailMessage[] {
  const messages: EmailMessage[] = [];
  const stay =
    `${d.propertyName} - ${d.unitName}\n` +
    `Check-in:  ${d.checkIn}\n` +
    `Check-out: ${d.checkOut}`;
  const paid = `Paid online: ${formatIdr(d.amountPaidIdr)}`;
  const balance =
    d.totalPriceIdr !== null && d.totalPriceIdr > d.amountPaidIdr
      ? `\nBalance at the property: ${formatIdr(d.totalPriceIdr - d.amountPaidIdr)}`
      : '';

  if (d.guestEmail) {
    messages.push({
      to: d.guestEmail,
      subject: `Your booking is confirmed - ${d.propertyName}`,
      text:
        `Hi ${d.guestName ?? 'there'},\n\n` +
        `Your booking is confirmed. We look forward to hosting you.\n\n` +
        `${stay}\n\n${paid}${balance}\n\n` +
        `Booking reference: ${d.bookingId}\n`,
    });
  }

  for (const owner of d.ownerEmails) {
    messages.push({
      to: owner,
      subject: `New confirmed booking - ${d.propertyName}`,
      text:
        `A booking was just confirmed.\n\n` +
        `${stay}\n` +
        `Guest: ${d.guestName ?? '-'}\n\n${paid}${balance}\n\n` +
        `Booking reference: ${d.bookingId}\n`,
    });
  }

  return messages;
}
