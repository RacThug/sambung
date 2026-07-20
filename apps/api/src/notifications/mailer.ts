/**
 * The email boundary (FR-NOTIF-1). Everything the app knows about sending an email
 * is this port; the provider specifics live behind it in one adapter, so the
 * default `LogMailer` (renders + logs, no credentials, no recurring cost -
 * invariant #8) can be swapped for a real Resend/SMTP adapter with zero call-site
 * changes and every test binds a fake that records what would be sent.
 *
 * A port, not an env-flag stub: the seam is a dependency the module binds and a
 * test overrides (`.overrideProvider(MAILER)`), so there is no second code path
 * that could ship. Injected by this token because an interface has no runtime
 * identity to inject by. Symmetric with PAYMENT_GATEWAY (ADR-0015).
 */
export const MAILER = Symbol('MAILER');

/** One email to send. `text` is the required plain body; `html` is optional and a
 * real provider may render it. Deliberately minimal - a v1 confirmation needs no
 * attachments, cc, or templating engine. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Send one message, or reject on failure. The caller (NotificationsService) is
   * best-effort and swallows rejections, so a send failure never breaks the flow
   * it rode in on (api-spec §6.2 step 3). */
  send(message: EmailMessage): Promise<void>;
}
