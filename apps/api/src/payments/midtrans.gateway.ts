import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentProvider } from '@sambung/shared';
import type {
  CreateSessionInput,
  PaymentGateway,
  PaymentSession,
} from './payment-gateway';

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
}
