import { createHash } from 'node:crypto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MidtransGateway, midtransOutcome } from './midtrans.gateway';
import type { GatewayCredential, PaymentOutcome } from './payment-gateway';

/**
 * The REAL signature crypto (#53) - the one thing the webhook fake cannot stand
 * in for. No network: verifyAndParse never calls Midtrans, it only hashes. So
 * this proves the SHA512 check and the status→outcome mapping directly.
 *
 * Since REQ-PA-04 the key is the TENANT's credential, passed per call - there is
 * no env key to configure, and no "unconfigured" 500 here any more (a missing
 * credential is the caller's 409/no-op, decided before this is reached).
 */
describe('MidtransGateway.verifyAndParse', () => {
  const SERVER_KEY = 'sandbox-server-key';
  const credential: GatewayCredential = {
    serverKey: SERVER_KEY,
    environment: 'sandbox',
  };

  const config = {
    get: () => undefined,
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
    const event = gateway.verifyAndParse(notification(), credential);
    expect(event.providerEventId).toBe('txn-1:settlement');
    expect(event.orderId).toBe('order-1');
    expect(event.outcome).toBe('settlement');
    expect(event.grossAmountIdr).toBe(4_000_000n);
    expect(event.raw).toMatchObject({ order_id: 'order-1' });
  });

  it('throws 401 when the signature does not match', () => {
    expect(() =>
      gateway.verifyAndParse(
        notification({ signature_key: 'deadbeef' }),
        credential,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('throws 401 when a signed field is tampered after signing', () => {
    // Valid signature for 4,000,000, but the amount is swapped to 9,000,000.
    expect(() =>
      gateway.verifyAndParse(
        notification({ gross_amount: '9000000.00' }),
        credential,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('throws 400 on a malformed body', () => {
    expect(() => gateway.verifyAndParse({ order_id: 'x' }, credential)).toThrow(
      BadRequestException,
    );
  });

  it("throws 401 under ANOTHER tenant's key - resolve-first means never verify across tenants (WH-01)", () => {
    // A correctly-signed notification for tenant A, verified under tenant B's
    // key, must read as forged. This is the wire-level fact behind the webhook's
    // resolve-tenant-first ordering.
    expect(() =>
      gateway.verifyAndParse(notification(), {
        serverKey: 'some-other-tenants-key',
        environment: 'sandbox',
      }),
    ).toThrow(UnauthorizedException);
  });

  it('peeks order_id from an unverified body, and only a string one', () => {
    expect(gateway.peekOrderId(notification())).toBe('order-1');
    expect(gateway.peekOrderId({ order_id: 42 })).toBeNull();
    expect(gateway.peekOrderId(null)).toBeNull();
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
