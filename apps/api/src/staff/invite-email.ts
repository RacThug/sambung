import type { EmailMessage } from '../notifications/mailer';

export interface InviteEmailData {
  to: string;
  tenantName: string;
  invitedBy: string;
  propertyNames: string[];
  acceptUrl: string;
  expiresAt: Date;
}

/**
 * Render the staff invite email (#57, FR-AUTH-2). PURE, like
 * renderConfirmationEmail: no I/O, so a test asserts the recipient, the link and
 * the property list without a mailer.
 *
 * The link carries the raw token and this is the ONLY place it ever appears -
 * the API never returns it, and the row stores only its hash. Losing the email
 * means revoking and re-inviting, which is the intended trade.
 *
 * English only, deliberately. ADR-0024 gave three languages to the guest funnel,
 * where a stranger decides to pay; this is an operator-facing account email, the
 * same audience (and the same call) as the English-only dashboard.
 */
export function renderInviteEmail(d: InviteEmailData): EmailMessage {
  const properties = d.propertyNames.map((n) => `  - ${n}`).join('\n');
  const expires = d.expiresAt.toISOString().slice(0, 10);
  return {
    to: d.to,
    subject: `${d.invitedBy} invited you to help manage ${d.tenantName}`,
    text:
      `Hi,\n\n` +
      `${d.invitedBy} has invited you to join ${d.tenantName} on Sambung as a ` +
      `staff member.\n\n` +
      `You'll be able to manage:\n${properties}\n\n` +
      `Set your password and get started:\n${d.acceptUrl}\n\n` +
      `This link can be used once, and expires on ${expires}.\n` +
      `If you weren't expecting this, you can ignore it.\n`,
  };
}
