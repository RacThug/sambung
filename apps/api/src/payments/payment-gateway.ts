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

export interface PaymentGateway {
  /** Which Provider this adapter is - stamped onto the payment row and the wire. */
  readonly provider: PaymentProvider;
  /** Open a checkout session for `input`, or throw if the Provider refuses /
   * is unreachable / is unconfigured (→ the pay endpoint surfaces a 5xx and the
   * hold survives for a retry, page-spec §3.2). */
  createSession(input: CreateSessionInput): Promise<PaymentSession>;
}
