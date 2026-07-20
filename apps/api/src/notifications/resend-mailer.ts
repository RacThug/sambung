import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailMessage, Mailer } from './mailer';

/** Resend's transactional-send endpoint. Overridable by env only for testing
 * against a mock host; prod uses this default. */
export const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com/emails';

/**
 * Bound the HTTP send. This runs in the webhook's post-commit seam (best-effort,
 * already off the request's critical path), but a hung provider must not pin a
 * pooled connection indefinitely - fail fast and let the caller log it.
 */
const SEND_TIMEOUT_MS = 8_000;

/**
 * The REAL confirmation-email adapter (#119, FR-NOTIF-1). Sends over the Resend
 * HTTP API with native `fetch` - no SDK, mirroring MidtransGateway (ADR-0015): a
 * single authenticated POST needs no dependency, and staying dependency-light
 * keeps the whole adapter replaceable by the test fake (invariant #8). Resend's
 * free tier is the allowed zero-cost provider; NEVER a paid plan.
 *
 * Bound behind the `Mailer` port ONLY when configured (see mailer.factory) - so
 * dev/test/unconfigured-prod fall back to LogMailer and no suite ever reaches a
 * live provider. Keys are read at CALL time (like MidtransGateway) so construction
 * is inert and the missing-var failure names itself.
 *
 * REJECTS on any failure (non-2xx, network, unconfigured). The caller
 * (NotificationsService) is best-effort and swallows the rejection, so a bounced
 * email is logged but can never undo a confirmed booking or fail the webhook the
 * provider is retrying (api-spec §6.2 step 3, AC (b)).
 */
@Injectable()
export class ResendMailer implements Mailer {
  private readonly logger = new Logger(ResendMailer.name);

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage): Promise<void> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    const from = this.config.get<string>('MAIL_FROM');
    if (!apiKey || !from) {
      // Should not happen (the factory only binds this adapter when both are set),
      // but guard anyway so a misconfiguration rejects loudly rather than pretends
      // to have sent. The caller logs and moves on.
      throw new Error('Email is not configured (RESEND_API_KEY / MAIL_FROM)');
    }
    const baseUrl =
      this.config.get<string>('RESEND_BASE_URL') ?? RESEND_DEFAULT_BASE_URL;

    let res: Response;
    try {
      res = await fetch(baseUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          // Only include html when the message actually carries one - a v1
          // confirmation is text-only, and Resend requires at least one of the two.
          ...(message.html ? { html: message.html } : {}),
        }),
      });
    } catch (cause) {
      // Network / DNS failure or the SEND_TIMEOUT_MS abort. Reject so the caller
      // logs it; the booking is already confirmed regardless.
      this.logger.error(`Resend unreachable: ${String(cause)}`);
      throw new Error(`Resend request failed: ${String(cause)}`);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Resend ${res.status}: ${detail}`);
      throw new Error(`Resend rejected the send (${res.status})`);
    }
  }
}
