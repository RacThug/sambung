import type { EmailMessage, Mailer } from './mailer';
import type { ConfirmationEmailData } from './confirmation-email';
import type { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * Per-recipient send isolation (#126). The confirmation notifier sends the guest
 * FIRST, then the owner. With #54's LogMailer (never throws) both always went out;
 * the real ResendMailer (#119) CAN reject, and a guest-send failure must NOT abort
 * the loop and silently drop the owner's operationally-important new-booking email
 * (nor vice-versa). This proves each recipient is isolated, the OTHER is still
 * attempted, and the whole thing never rethrows (the outer best-effort guarantee
 * that keeps the webhook/confirmation at 200).
 */
describe('NotificationsService per-recipient isolation', () => {
  const GUEST = 'guest@example.com';
  const OWNER = 'owner@villa.dev';

  const data: ConfirmationEmailData = {
    bookingId: 'bk-1',
    guestName: 'Made A.',
    guestEmail: GUEST,
    ownerEmails: [OWNER],
    propertyName: 'Seminyak Villa',
    unitName: 'Garden Room',
    checkIn: '2029-03-10',
    checkOut: '2029-03-14',
    totalPriceIdr: 4_000_000n,
    amountPaidIdr: 1_200_000n,
  };

  /** Records what was actually sent, and can be told to reject one address (a
   * bounced recipient) while accepting the rest. `attempted` records every call,
   * so a test can prove the loop did NOT abort after a rejection. */
  class SelectiveMailer implements Mailer {
    readonly attempted: string[] = [];
    readonly sent: string[] = [];
    constructor(private readonly rejectFor: string | null) {}
    send(message: EmailMessage): Promise<void> {
      this.attempted.push(message.to);
      if (this.rejectFor !== null && message.to === this.rejectFor) {
        return Promise.reject(new Error(`bounced: ${message.to}`));
      }
      this.sent.push(message.to);
      return Promise.resolve();
    }
  }

  const repoReturning = (d: ConfirmationEmailData | null) =>
    ({
      readConfirmationData: () => Promise.resolve(d),
    }) as unknown as NotificationsRepository;

  const serviceWith = (mailer: Mailer, d = data) =>
    new NotificationsService(repoReturning(d), mailer);

  it('still emails the owner when the guest send fails', async () => {
    const mailer = new SelectiveMailer(GUEST); // the guest address bounces
    await expect(
      serviceWith(mailer).notifyBookingConfirmed('bk-1'),
    ).resolves.toBeUndefined();

    // BOTH were attempted (the loop did not abort on the guest's rejection)...
    expect(mailer.attempted).toEqual([GUEST, OWNER]);
    // ...and the owner - sent second - still went out.
    expect(mailer.sent).toEqual([OWNER]);
  });

  it('still emails the guest when the owner send fails (symmetric)', async () => {
    const mailer = new SelectiveMailer(OWNER); // the owner address bounces
    await expect(
      serviceWith(mailer).notifyBookingConfirmed('bk-1'),
    ).resolves.toBeUndefined();

    expect(mailer.attempted).toEqual([GUEST, OWNER]);
    expect(mailer.sent).toEqual([GUEST]);
  });

  it('never rethrows even when BOTH sends fail', async () => {
    // rejectFor null-by-address won't match; make a mailer that rejects everything.
    const alwaysFails: Mailer = {
      send: () => Promise.reject(new Error('mailer is down')),
    };
    await expect(
      serviceWith(alwaysFails).notifyBookingConfirmed('bk-1'),
    ).resolves.toBeUndefined();
  });

  it('sends both recipients when the mailer is healthy', async () => {
    const mailer = new SelectiveMailer(null);
    await serviceWith(mailer).notifyBookingConfirmed('bk-1');
    expect(mailer.sent).toEqual([GUEST, OWNER]);
  });
});
