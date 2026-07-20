import { Inject, Injectable, Logger } from '@nestjs/common';
import { renderConfirmationEmail } from './confirmation-email';
import { MAILER, type Mailer } from './mailer';
import { NotificationsRepository } from './notifications.repository';

/**
 * The FR-NOTIF-1 confirmation notifier: guest + owner email when a booking flips
 * to `confirmed`. Called from the payment webhook's post-commit seam, on the
 * transition that happens EXACTLY ONCE across every delivery path (the pushed
 * webhook and the confirmation page's reconcile-on-read both funnel through the
 * same status-guarded confirm, ADR-0018/0020) - so "email exactly once per
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
      let sent = 0;
      for (const message of messages) {
        // Per-recipient isolation (#126): each send is its own best-effort unit.
        // The guest is sent FIRST, so without this a guest-address bounce would
        // abort the loop and silently drop the owner's new-booking email (the
        // operationally more important one) - and vice-versa. Catch here so one
        // recipient's failure is logged and the OTHER is still attempted.
        try {
          await this.mailer.send(message);
          sent++;
        } catch (err) {
          this.logger.warn(
            `Confirmation email to ${message.to} failed for booking ${bookingId}: ${String(err)}`,
          );
        }
      }
      this.logger.log(
        `Confirmation emailed for booking ${bookingId} (${sent}/${messages.length} sent)`,
      );
    } catch (err) {
      // Never rethrow: a read/render failure must not break the webhook / reconcile
      // flow. Individual send failures are already isolated + logged in the loop.
      this.logger.error(
        `Confirmation notification failed for booking ${bookingId}: ${String(err)}`,
      );
    }
  }
}
