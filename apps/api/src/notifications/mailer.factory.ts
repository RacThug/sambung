import { ConfigService } from '@nestjs/config';
import { LogMailer } from './log-mailer';
import type { Mailer } from './mailer';
import { ResendMailer } from './resend-mailer';

/**
 * Choose the email adapter from the environment (#119, FR-NOTIF-1). Returns the
 * REAL `ResendMailer` only when the provider is fully configured
 * (`RESEND_API_KEY` + `MAIL_FROM`), and otherwise the zero-cost `LogMailer` that
 * renders + logs the message (invariant #8 - no paid service, no credentials).
 *
 * This is the single seam that keeps two guarantees true by construction:
 *  - dev, the whole test suite, and an unconfigured prod all stay on LogMailer, so
 *    no live provider is ever touched without an explicit env flip;
 *  - swapping in real sending is ONE env var, with zero call-site change (the
 *    webhook keeps calling the `Mailer` port, ADR-0020).
 *
 * A factory, not the payment-gateway's `useClass` + loud-throw shape: email is a
 * best-effort post-commit seam, so the sensible behaviour when unconfigured is to
 * degrade gracefully to a rendered log line - not to throw a 500 that the caller
 * swallows anyway. Payment must fail loud (you cannot fake taking money); email
 * must not (a confirmed booking must not depend on a mailer being wired).
 */
export function createMailer(config: ConfigService): Mailer {
  const apiKey = config.get<string>('RESEND_API_KEY');
  const from = config.get<string>('MAIL_FROM');
  if (apiKey && from) {
    return new ResendMailer(config);
  }
  return new LogMailer();
}
