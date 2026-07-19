import { createHash } from 'node:crypto';
import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MidtransGateway, midtransOutcome } from './midtrans.gateway';
import type { PaymentOutcome } from './payment-gateway';

/**
 * The REAL signature crypto (#53) - the one thing the webhook fake cannot stand
 * in for. No network: verifyAndParse never calls Midtrans, it only hashes. So
 * this proves the SHA512 check and the status→outcome mapping directly.
 */
describe('MidtransGateway.verifyAndParse', () => {
  const SERVER_KEY = 'sandbox-server-key';

  const config = {
    get: (key: string) =>
      key === 'MIDTRANS_SERVER_KEY' ? SERVER_KEY : undefined,
  } as unknown as ConfigService;
  const gateway = new MidtransGateway(config);

  // Midtrans: signature_key = sha512(order_id + status_code + gross_amount + key).
  const sign = (orderId: string, statusCode: string, gross: string) =>
    createHash('sha512')
      .update(orderId + statusCode + gross + SERVER_KEY)
      .digest('hex');

  const notification = (over: Record<string, unknown> = {}) => {
    const order_id = 'order-1';
    const status_code = '200';
    const gross_amount = '4000000.00';
    return {
      order_id,
      status_code,
      gross_amount,
      transaction_id: 'txn-1',
      transaction_status: 'settlement',
      signature_key: sign(order_id, status_code, gross_amount),
      ...over,
    };
  };

  it('parses a correctly-signed settlement', () => {
    const event = gateway.verifyAndParse(notification());
    expect(event.providerEventId).toBe('txn-1:settlement');
    expect(event.orderId).toBe('order-1');
    expect(event.outcome).toBe('settlement');
    expect(event.grossAmountIdr).toBe(4_000_000);
    expect(event.raw).toMatchObject({ order_id: 'order-1' });
  });

  it('throws 401 when the signature does not match', () => {
    expect(() =>
      gateway.verifyAndParse(notification({ signature_key: 'deadbeef' })),
    ).toThrow(UnauthorizedException);
  });

  it('throws 401 when a signed field is tampered after signing', () => {
    // Valid signature for 4,000,000, but the amount is swapped to 9,000,000.
    expect(() =>
      gateway.verifyAndParse(notification({ gross_amount: '9000000.00' })),
    ).toThrow(UnauthorizedException);
  });

  it('throws 400 on a malformed body', () => {
    expect(() => gateway.verifyAndParse({ order_id: 'x' })).toThrow(
      BadRequestException,
    );
  });

  it('throws 500 when the server key is unconfigured', () => {
    const noKey = new MidtransGateway({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(() => noKey.verifyAndParse(notification())).toThrow(
      InternalServerErrorException,
    );
  });

  describe('midtransOutcome', () => {
    const cases: Array<[string, string | undefined, PaymentOutcome]> = [
      ['settlement', undefined, 'settlement'],
      ['capture', 'accept', 'settlement'],
      ['capture', 'challenge', 'pending'],
      ['capture', 'deny', 'failure'],
      ['pending', undefined, 'pending'],
      ['deny', undefined, 'failure'],
      ['cancel', undefined, 'failure'],
      ['expire', undefined, 'failure'],
      ['refund', undefined, 'ignore'],
      ['chargeback', undefined, 'ignore'],
    ];
    it.each(cases)('maps %s/%s → %s', (status, fraud, expected) => {
      expect(midtransOutcome(status, fraud)).toBe(expected);
    });
  });
});
