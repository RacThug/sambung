import { Inject, Injectable, Logger } from '@nestjs/common';
import { renderConfirmationEmail } from './confirmation-email';
import { MAILER, type Mailer } from './mailer';
import { NotificationsRepository } from './notifications.repository';

/**
 * The FR-NOTIF-1 confirmation notifier: guest + owner email when a booking flips
 * to `confirmed`. Called from the payment webhook's post-commit seam, on the
 * transition that happens EXACTLY ONCE across every delivery path (the pushed
 * webhook and the confirmation page's reconcile-on-read both funnel through the
 * same status-guarded confirm, ADR-0018/0019) - so "email exactly once per
 * confirmation" is guaranteed upstream, and this class need only send.
 *
 * BEST-EFFORT by construction (api-spec §6.2 step 3): every failure is caught and
 * logged, never rethrown. The booking is already confirmed and the money is in;
 * a bounced email must not undo that or fail the webhook the provider is retrying.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly repo: NotificationsRepository,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async notifyBookingConfirmed(bookingId: string): Promise<void> {
    try {
      const data = await this.repo.readConfirmationData(bookingId);
      if (!data) {
        this.logger.warn(
          `Confirmation notify: booking ${bookingId} not found - skipped`,
        );
        return;
      }
      const messages = renderConfirmationEmail(data);
      for (const message of messages) {
        await this.mailer.send(message);
      }
      this.logger.log(
        `Confirmation emailed for booking ${bookingId} (${messages.length} message(s))`,
      );
    } catch (err) {
      // Never rethrow: a send failure must not break the webhook / reconcile flow.
      this.logger.error(
        `Confirmation notification failed for booking ${bookingId}: ${String(err)}`,
      );
    }
  }
}
