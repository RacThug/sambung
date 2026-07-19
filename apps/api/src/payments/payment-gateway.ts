import type { PaymentProvider } from '@sambung/shared';

/**
 * The Provider boundary (ADR-0015, api-spec §6.1 AC #3). Everything the app knows
 * about talking to a payment Provider is this interface; the Midtrans specifics
 * live behind it in one adapter, and tests bind a fake so no suite ever reaches
 * live Midtrans.
 *
 * A port, not an env-flag stub: the seam is a dependency the test module swaps
 * (`.overrideProvider(PAYMENT_GATEWAY)`), so there is no second code path that
 * could ship to prod. Injected by this token because an interface has no runtime
 * identity to inject by.
 */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** What the app hands the Provider to open a checkout session. `orderId` is the
 * payment row's id (globally unique, ADR-0015); `amountIdr` is what to charge now
 * (the Deposit share, already floored). `customer` prefills the Provider's form. */
export interface CreateSessionInput {
  orderId: string;
  amountIdr: number;
  itemName: string;
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
  };
  /** Where the Provider returns the guest after they finish paying - our
   * `/booking/:id` page (page-spec §3.2). Null when unconfigured (the Provider
   * then falls back to its dashboard-configured redirect). */
  finishUrl: string | null;
}

/** What the Provider hands back: the session the guest is sent to. `redirectUrl`
 * is the hosted page; `token` is the Provider's session handle (Snap), returned
 * for a client that embeds rather than redirects. */
export interface PaymentSession {
  token: string;
  redirectUrl: string;
}

/**
 * What a verified webhook boils down to once the Provider's vocabulary is
 * translated at the port (#53, boss fight #4):
 * - `settlement` → money in: `payment` paid, `booking` confirmed.
 * - `failure` → denied / expired / cancelled: `payment` failed, the hold keeps
 *   ticking until the sweeper expires it (api-spec §6.2).
 * - `pending` → recorded, no state change (the guest hasn't paid yet).
 * - `ignore` → a status we don't act on (refund, chargeback, …): recorded, no
 *   state change, so it can't silently drive a transition we haven't designed.
 */
export type PaymentOutcome = 'settlement' | 'failure' | 'pending' | 'ignore';

/**
 * A verified provider event, in the app's own words (#53). The adapter does the
 * crypto and knows the wire field names; everything past the port speaks this.
 */
export interface ParsedPaymentEvent {
  /**
   * The idempotency key. Stable across redeliveries of the SAME transition
   * (which is all a provider retry is), distinct across a charge's
   * pending→settlement steps - so a settlement is never mistaken for a duplicate
   * of the pending that preceded it. Stored as `payment_event.provider_event_id`
   * under the `(provider, provider_event_id)` unique constraint (ADR-0018).
   */
  providerEventId: string;
  /** The Provider `order_id` = our `payment.id` (ADR-0015): the row to resolve. */
  orderId: string;
  /** What this event means for the booking/payment state machine. */
  outcome: PaymentOutcome;
  /** The amount the Provider reports, in whole IDR - cross-checked against the
   * snapshot on the payment row (a mismatch is refused, never confirmed). */
  grossAmountIdr: number;
  /** The verified payload, stored verbatim on `payment_event` for audit. */
  raw: unknown;
}

export interface PaymentGateway {
  /** Which Provider this adapter is - stamped onto the payment row and the wire. */
  readonly provider: PaymentProvider;
  /** Open a checkout session for `input`, or throw if the Provider refuses /
   * is unreachable / is unconfigured (→ the pay endpoint surfaces a 5xx and the
   * hold survives for a retry, page-spec §3.2). */
  createSession(input: CreateSessionInput): Promise<PaymentSession>;
  /**
   * Verify the webhook's Provider signature and translate the payload into a
   * `ParsedPaymentEvent`, or throw: `UnauthorizedException` on a signature
   * mismatch (→ 401), `BadRequestException` on a malformed body (→ 400). The
   * signature crypto and the Provider's field names live behind this port
   * (ADR-0015); the webhook service never sees either.
   */
  verifyAndParse(body: unknown): ParsedPaymentEvent;
}
