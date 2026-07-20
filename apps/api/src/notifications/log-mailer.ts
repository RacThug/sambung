import { Injectable, Logger } from '@nestjs/common';
import type { EmailMessage, Mailer } from './mailer';

/**
 * The default, zero-cost email adapter (FR-NOTIF-1, invariant #8 - no paid
 * services). It fully RENDERS the message and logs it, rather than dropping the
 * content - so the confirmation email is real and inspectable in dev/prod logs
 * today, and swapping in a real provider (Resend free tier / SMTP) is a new
 * adapter bound to MAILER with no change anywhere else.
 *
 * Never throws: a log write can't fail the flow it rode in on. Returns a resolved
 * promise so the port stays async (a real sender is I/O).
 */
@Injectable()
export class LogMailer implements Mailer {
  private readonly logger = new Logger(LogMailer.name);

  send(message: EmailMessage): Promise<void> {
    this.logger.log(
      `[email] to=${message.to} subject=${JSON.stringify(message.subject)}\n` +
        message.text,
    );
    return Promise.resolve();
  }
}
