import { Module } from '@nestjs/common';
import { LogMailer } from './log-mailer';
import { MAILER } from './mailer';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * The notification domain (FR-NOTIF-1, #54). Exposes NotificationsService, which
 * the payments webhook calls on the confirmed transition.
 *
 * MAILER is bound to LogMailer (renders + logs, no paid provider - invariant #8);
 * a real Resend/SMTP adapter is a one-line rebind here with no call-site change,
 * and tests `.overrideProvider(MAILER)` with a fake that records what was sent.
 * DbModule (DbService, the owner connection the confirmation read uses) is @Global.
 */
@Module({
  providers: [
    NotificationsService,
    NotificationsRepository,
    { provide: MAILER, useClass: LogMailer },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
