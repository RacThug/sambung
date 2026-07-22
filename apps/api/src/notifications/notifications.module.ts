import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAILER } from './mailer';
import { createMailer } from './mailer.factory';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * The notification domain (FR-NOTIF-1, #54/#119). Exposes NotificationsService,
 * which the payments webhook calls on the confirmed transition.
 *
 * MAILER is bound by `createMailer`, which reads the environment: the real
 * `ResendMailer` when configured (`RESEND_API_KEY` + `MAIL_FROM`), otherwise the
 * zero-cost `LogMailer` (renders + logs, no paid provider - invariant #8). So
 * dev/test/unconfigured-prod stay off any live provider, and turning real sending
 * on is one env var with no call-site change. Tests `.overrideProvider(MAILER)`
 * with a fake that records what was sent. DbModule (DbService, the owner
 * connection the confirmation read uses) is @Global.
 */
@Module({
  providers: [
    NotificationsService,
    NotificationsRepository,
    { provide: MAILER, useFactory: createMailer, inject: [ConfigService] },
  ],
  // MAILER too, since #57: the staff invite email is not a booking notification,
  // so it does not belong behind NotificationsService - but it must go out
  // through the SAME bound adapter, or a deployment with Resend configured would
  // send confirmations for real and log invites to nowhere.
  exports: [NotificationsService, MAILER],
})
export class NotificationsModule {}
