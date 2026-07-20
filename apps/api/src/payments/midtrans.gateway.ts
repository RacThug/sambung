import { createHash, timingSafeEqual } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { PaymentProvider } from '@sambung/shared';
import type {
  CreateSessionInput,
  ParsedPaymentEvent,
  PaymentGateway,
  PaymentOutcome,
  PaymentSession,
} from './payment-gateway';

/**
 * The Midtrans HTTP notification (docs: "HTTP(S) POST notification"). Only the
 * fields we verify or act on - a webhook is external input, so it is validated
 * at the boundary (zod) before anything trusts it (invariant: trust no external
 * input). `gross_amount` stays the STRING Midtrans sent ("10000.00"): the
 * signature is computed over that exact text, so re-serializing it would break
 * the hash. `passthrough()` keeps the rest of the body for the audit payload.
 */
const midtransNotificationSchema = z
  .object({
    order_id: z.string().min(1),
    status_code: z.string().min(1),
    gross_amount: z.string().min(1),
    signature_key: z.string().min(1),
    transaction_status: z.string().min(1),
    transaction_id: z.string().min(1),
    fraud_status: z.string().optional(),
  })
  .passthrough();

/**
 * Midtrans transaction_status (+ fraud_status for card captures) → the app's
 * outcome vocabulary. `capture` needs the fraud check: `accept` is money in,
 * `challenge` is still pending review, anything else is a denial. Everything we
 * don't explicitly act on (refund, chargeback, authorize) is `ignore` - recorded
 * for the audit trail, but never driving a transition we haven't designed.
 */
export function midtransOutcome(
  transactionStatus: string,
  fraudStatus?: string,
): PaymentOutcome {
  switch (transactionStatus) {
    case 'capture':
      if (fraudStatus === 'accept') return 'settlement';
      if (fraudStatus === 'challenge') return 'pending';
      return 'failure';
    case 'settlement':
      return 'settlement';
    case 'pending':
      return 'pending';
    case 'deny':
    case 'cancel':
    case 'expire':
    case 'failure':
      return 'failure';
    default:
      return 'ignore';
  }
}

/**
 * The one Provider adapter (ADR-0015). Talks to Midtrans Snap over `fetch` - no
 * SDK, because session-create is a single authenticated POST and staying
 * dependency-light keeps the whole adapter replaceable by the test fake (invariant
 * #8). Sandbox only for v1 (invariant #8 - no paid third-party services).
 *
 * Keys come from ConfigService and are read at CALL time, not construction: the
 * app must boot for `pnpm dev` / tests without Midtrans keys (the fake replaces
 * this in tests, and an owner may not have configured it yet). An actual pay
 * attempt without a server key fails loud with a message naming the missing var.
 */
/**
 * Cap on the Snap call. It runs INSIDE the pay transaction, which holds a
 * `FOR UPDATE` lock on the booking (the serialization that makes retry reuse one
 * row - ADR-0015). Without a bound, a hung provider would pin a pooled connection
 * AND that row lock for undici's ~300s default; this fails fast instead, so the
 * hold survives for a retry (BadGateway) rather than starving the pool.
 */
const SNAP_TIMEOUT_MS = 8_000;

@Injectable()
export class MidtransGateway implements PaymentGateway {
  readonly provider: PaymentProvider = 'midtrans';
  private readonly logger = new Logger(MidtransGateway.name);

  constructor(private readonly config: ConfigService) {}

  async createSession(input: CreateSessionInput): Promise<PaymentSession> {
    const serverKey = this.config.get<string>('MIDTRANS_SERVER_KEY');
    if (!serverKey) {
      // Not a client error: the guest did nothing wrong, the server is
      // misconfigured. 500 so it reads as ours to fix (and the hold survives).
      throw new InternalServerErrorException(
        'Payments are not configured (MIDTRANS_SERVER_KEY is unset)',
      );
    }
    const baseUrl =
      this.config.get<string>('MIDTRANS_SNAP_BASE_URL') ??
      'https://app.sandbox.midtrans.com/snap/v1/transactions';

    // Basic auth: the server key is the username, password empty (Midtrans spec).
    const auth = Buffer.from(`${serverKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(baseUrl, {
        method: 'POST',
        // Bound the time this call - and the row lock around it - can be held.
        signal: AbortSignal.timeout(SNAP_TIMEOUT_MS),
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          transaction_details: {
            order_id: input.orderId,
            gross_amount: input.amountIdr,
          },
          // One line equal to the gross amount - Midtrans requires item prices
          // to sum to gross_amount when item_details is present. Name is capped
          // at Midtrans's 50-char limit.
          item_details: [
            {
              id: input.orderId,
              price: input.amountIdr,
              quantity: 1,
              name: input.itemName.slice(0, 50),
            },
          ],
          customer_details: {
            first_name: input.customer.name ?? undefined,
            email: input.customer.email ?? undefined,
            phone: input.customer.phone ?? undefined,
          },
          // Bring the guest back to our confirmation page after Snap (page-spec
          // §3.2). Omitted when unconfigured, so Midtrans uses its dashboard URL.
          ...(input.finishUrl
            ? { callbacks: { finish: input.finishUrl } }
            : {}),
        }),
      });
    } catch (cause) {
      // Network / DNS failure OR the SNAP_TIMEOUT_MS abort - upstream is down or
      // too slow, not our bug. Either way the hold survives for a retry.
      this.logger.error(`Midtrans unreachable: ${String(cause)}`);
      throw new BadGatewayException('Payment provider is unreachable');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Midtrans ${res.status}: ${detail}`);
      throw new BadGatewayException('Payment provider rejected the request');
    }

    const body = (await res.json().catch(() => null)) as {
      token?: unknown;
      redirect_url?: unknown;
    } | null;
    if (
      !body ||
      typeof body.token !== 'string' ||
      typeof body.redirect_url !== 'string'
    ) {
      this.logger.error(`Midtrans returned an unexpected body`);
      throw new BadGatewayException(
        'Payment provider returned an invalid session',
      );
    }
    return { token: body.token, redirectUrl: body.redirect_url };
  }

  /**
   * Verify the notification's `signature_key` and translate it (api-spec §6.2,
   * #53). Midtrans signs `sha512(order_id + status_code + gross_amount +
   * ServerKey)` over the PARSED fields - not the raw body - so no raw-body
   * middleware is needed; we recompute the hash from the validated fields and
   * compare in constant time.
   *
   * Throws before trusting anything: `BadRequestException` (→ 400) if the body
   * is malformed, `UnauthorizedException` (→ 401) if the signature does not match
   * (api-spec §6.2). The idempotency key is `transaction_id:transaction_status`
   * so a redelivery collapses but a real pending→settlement does not (ADR-0018).
   */
  verifyAndParse(body: unknown): ParsedPaymentEvent {
    const parsed = midtransNotificationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Malformed webhook payload');
    }
    const n = parsed.data;

    const serverKey = this.config.get<string>('MIDTRANS_SERVER_KEY');
    if (!serverKey) {
      // Ours to fix, not the caller's: we can't verify without the key. 500 so
      // the provider retries once we're configured, rather than a false 401.
      throw new InternalServerErrorException(
        'Payments are not configured (MIDTRANS_SERVER_KEY is unset)',
      );
    }

    const expected = createHash('sha512')
      .update(n.order_id + n.status_code + n.gross_amount + serverKey)
      .digest('hex');
    if (!timingSafeEqualHex(expected, n.signature_key)) {
      this.logger.warn(`Webhook signature mismatch for order ${n.order_id}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return {
      providerEventId: `${n.transaction_id}:${n.transaction_status}`,
      orderId: n.order_id,
      outcome: midtransOutcome(n.transaction_status, n.fraud_status),
      grossAmountIdr: parseGrossAmountIdr(n.gross_amount),
      raw: n,
    };
  }

  /**
   * Reconcile-on-read (#54, api-spec §6.3): GET Midtrans's Get-Status API for
   * `orderId`. The status response is signed EXACTLY like a webhook notification
   * (sha512 over order_id + status_code + gross_amount + ServerKey), so it is
   * fed straight through `verifyAndParse` - one parser, no second copy to drift.
   *
   * A 404 (HTTP or the `status_code: "404"` body Midtrans returns for an unknown
   * order) means the Provider has no record yet → null, nothing to reconcile.
   */
  async fetchStatus(orderId: string): Promise<ParsedPaymentEvent | null> {
    const serverKey = this.config.get<string>('MIDTRANS_SERVER_KEY');
    if (!serverKey) {
      throw new InternalServerErrorException(
        'Payments are not configured (MIDTRANS_SERVER_KEY is unset)',
      );
    }
    const apiBase =
      this.config.get<string>('MIDTRANS_API_BASE_URL') ??
      'https://api.sandbox.midtrans.com/v2';
    const auth = Buffer.from(`${serverKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(`${apiBase}/${encodeURIComponent(orderId)}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(SNAP_TIMEOUT_MS),
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      });
    } catch (cause) {
      this.logger.error(`Midtrans status unreachable: ${String(cause)}`);
      throw new BadGatewayException('Payment provider is unreachable');
    }

    // Unknown order → nothing to reconcile. Midtrans answers 404 (and echoes
    // status_code "404" in the body); either signal means "no record".
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Midtrans status ${res.status}: ${detail}`);
      throw new BadGatewayException('Payment provider status check failed');
    }

    const body = (await res.json().catch(() => null)) as {
      status_code?: unknown;
    } | null;
    if (!body) {
      throw new BadGatewayException(
        'Payment provider returned an invalid status',
      );
    }
    if (body.status_code === '404') return null;

    // Signed like a notification: reuse verify + translate.
    return this.verifyAndParse(body);
  }
}

/**
 * Parse Midtrans's `gross_amount` ("10000.00") to whole-rupiah `bigint` WITHOUT
 * going through a JS `number` (invariant #6 - money is never a float). IDR has no
 * sub-unit, so the fraction is always `.00`; we take the integer part and widen
 * straight to bigint. A non-numeric integer part is a malformed body (→ 400).
 */
function parseGrossAmountIdr(gross: string): bigint {
  const intPart = gross.split('.')[0];
  if (!/^\d+$/.test(intPart)) {
    throw new BadRequestException('Webhook gross_amount is not a whole number');
  }
  return BigInt(intPart);
}

/**
 * Constant-time hex-string compare. `timingSafeEqual` throws on unequal-length
 * buffers, so the length guard is required - and it leaks only length, which for
 * a real sha512 signature is always 128 chars anyway. A forged signature of the
 * wrong length is rejected here without timing signal past its length.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
