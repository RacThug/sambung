import {
  renderConfirmationEmail,
  type ConfirmationEmailData,
} from './confirmation-email';

/**
 * The confirmation-email renderer is pure (FR-NOTIF-1) - no mailer, no DB - so a
 * unit test can pin recipients, subjects and body without any I/O. "Exactly once"
 * is proven at the webhook level (confirmation.spec / payment-webhook.spec); here
 * we only prove the CONTENT and the recipient fan-out.
 */
describe('renderConfirmationEmail', () => {
  const base: ConfirmationEmailData = {
    bookingId: 'bk-123',
    guestName: 'Made A.',
    guestEmail: 'made@example.com',
    ownerEmails: ['owner@villa.dev'],
    propertyName: 'Seminyak Beach Villa',
    unitName: 'Garden Room 1',
    checkIn: '2027-03-10',
    checkOut: '2027-03-14',
    totalPriceIdr: 4_000_000n,
    amountPaidIdr: 1_200_000n,
  };

  it('emails the guest and each owner', () => {
    const messages = renderConfirmationEmail({
      ...base,
      ownerEmails: ['owner@villa.dev', 'cohost@villa.dev'],
    });
    expect(messages.map((m) => m.to)).toEqual([
      'made@example.com',
      'owner@villa.dev',
      'cohost@villa.dev',
    ]);
    // Guest subject vs owner subject differ.
    expect(messages[0].subject).toContain('confirmed');
    expect(messages[1].subject).toContain('New confirmed booking');
  });

  it('includes the stay, the paid amount and the balance', () => {
    const [guest] = renderConfirmationEmail(base);
    expect(guest.text).toContain('Seminyak Beach Villa - Garden Room 1');
    expect(guest.text).toContain('2027-03-10');
    expect(guest.text).toContain('2027-03-14');
    expect(guest.text).toContain('Rp 1.200.000'); // paid online (deposit)
    expect(guest.text).toContain('Rp 2.800.000'); // balance at the property
    expect(guest.text).toContain('bk-123');
  });

  it('omits the balance line when paid in full', () => {
    const [guest] = renderConfirmationEmail({
      ...base,
      amountPaidIdr: 4_000_000n,
    });
    expect(guest.text).not.toContain('Balance at the property');
  });

  it('skips the guest email when the guest gave none', () => {
    const messages = renderConfirmationEmail({ ...base, guestEmail: null });
    expect(messages.map((m) => m.to)).toEqual(['owner@villa.dev']);
  });

  it('greets a nameless guest gracefully', () => {
    const [guest] = renderConfirmationEmail({ ...base, guestName: null });
    expect(guest.text).toContain('Hi there,');
  });

  it('returns nothing to send with no guest email and no owners', () => {
    expect(
      renderConfirmationEmail({ ...base, guestEmail: null, ownerEmails: [] }),
    ).toHaveLength(0);
  });
});
