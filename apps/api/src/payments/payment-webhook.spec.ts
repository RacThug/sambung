import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import {
  booking,
  payment,
  paymentEvent,
  property,
  tenant,
  unit,
} from '@sambung/db';
import type { AuthResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { testSlug } from '../test-helpers';
import type { FakeWebhookBody } from './fake-payment.gateway';
import { FakePaymentGateway } from './fake-payment.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { PaymentWebhookService } from './payment-webhook.service';

/**
 * The idempotent payment webhook - boss fight #4 (api-spec §6.2, FR-PAY-2, #53).
 *
 * Real Postgres so the `payment_event` unique constraint, the transaction
 * boundary and the guarded status transitions are all genuinely exercised. The
 * Provider is the fake bound over PAYMENT_GATEWAY (AC #3), so no test reaches
 * live Midtrans; the fake's `verifyAndParse` lets a test craft an event by intent
 * and simulate a bad signature without recomputing an HMAC.
 */
describe('Payment webhook (idempotent → confirmed)', () => {
  let app: INestApplication;
  let dbs: DbService;
  let svc: PaymentWebhookService;
  const fake = new FakePaymentGateway();
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  let tenantAId: string;
  let unitId: string;

  const deliver = (provider: string, body: object) =>
    request(server()).post(`/api/webhooks/payment/${provider}`).send(body);

  // Distinct dates per booking so occupying rows never collide on the exclusion
  // constraint - the suite shares one unit and never cleans up between tests.
  let stayOffset = 0;
  const uniqueStay = (): { checkIn: string; checkOut: string } => {
    const start = new Date(Date.UTC(2028, 0, 10 + stayOffset));
    stayOffset += 6;
    const end = new Date(start.getTime() + 4 * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { checkIn: iso(start), checkOut: iso(end) };
  };

  /** Seed a booking directly (owner connection, bypasses RLS). */
  const seedBooking = (values: {
    status?: 'pending_payment' | 'confirmed' | 'expired' | 'cancelled';
    holdExpiresAt?: Date | null;
    totalPriceIdr?: bigint | null;
  }) => {
    const { checkIn, checkOut } = uniqueStay();
    return dbs.db
      .insert(booking)
      .values({
        tenantId: tenantAId,
        unitId,
        source: 'direct',
        status: values.status ?? 'pending_payment',
        checkIn,
        checkOut,
        guestName: 'Made A.',
        guestPhone: '+62 812 3456 7890',
        guestCount: 2,
        totalPriceIdr:
          values.totalPriceIdr === undefined
            ? 4_000_000n
            : values.totalPriceIdr,
        holdExpiresAt:
          values.holdExpiresAt === undefined
            ? new Date(Date.now() + 15 * 60_000)
            : values.holdExpiresAt,
      })
      .returning({ id: booking.id })
      .then((rows) => rows[0].id);
  };

  /** Seed a pending payment row - its id is the Provider order_id (ADR-0015). */
  const seedPayment = (bookingId: string, amountIdr = 4_000_000n) => {
    const id = randomUUID();
    return dbs.db
      .insert(payment)
      .values({
        id,
        bookingId,
        provider: 'midtrans',
        providerRef: id,
        amountIdr,
        status: 'pending',
        rawPayload: { token: `tok-${id}`, redirectUrl: 'https://x/y' },
      })
      .returning({ id: payment.id })
      .then((rows) => rows[0].id);
  };

  /** A full guest-hold + pending-payment pair, ready to settle. */
  const seedPayable = async (amountIdr = 4_000_000n) => {
    const bookingId = await seedBooking({ totalPriceIdr: amountIdr });
    const orderId = await seedPayment(bookingId, amountIdr);
    return { bookingId, orderId };
  };

  const settlement = (
    orderId: string,
    over: Partial<FakeWebhookBody> = {},
  ): FakeWebhookBody => ({
    orderId,
    transactionId: `txn-${randomUUID()}`,
    transactionStatus: 'settlement',
    grossAmountIdr: 4_000_000,
    ...over,
  });

  const statusOfBooking = (id: string) =>
    dbs.db
      .select({ status: booking.status })
      .from(booking)
      .where(eq(booking.id, id))
      .then((r) => r[0]?.status);

  const rowOfPayment = (id: string) =>
    dbs.db
      .select()
      .from(payment)
      .where(eq(payment.id, id))
      .then((r) => r[0]);

  const eventsForBooking = (bookingId: string) =>
    dbs.db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.bookingId, bookingId));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);
    svc = app.get(PaymentWebhookService);

    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: 'Webhook Tenant A',
        email: `wh+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    tenantAId = bodyOf<AuthResponse>(res).tenant.id;
    createdTenantIds.push(tenantAId);

    const [prop] = await dbs.db
      .insert(property)
      .values({ tenantId: tenantAId, name: 'WH Villa', slug: testSlug() })
      .returning({ id: property.id });
    const [u] = await dbs.db
      .insert(unit)
      .values({
        propertyId: prop.id,
        tenantId: tenantAId,
        name: 'WH Room',
        basePriceIdr: 1_000_000n,
      })
      .returning({ id: unit.id });
    unitId = u.id;
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  // --- AC #1: same webhook twice → confirmed once, second is a 200 no-op ------

  it('confirms exactly once and 200-no-ops a duplicate delivery', async () => {
    const { bookingId, orderId } = await seedPayable();
    const body = settlement(orderId);

    const first = await deliver('midtrans', body);
    expect(first.status).toBe(200);
    expect(await statusOfBooking(bookingId)).toBe('confirmed');
    expect((await rowOfPayment(orderId)).status).toBe('paid');

    // Byte-identical redelivery: the unique constraint says "already processed".
    const second = await deliver('midtrans', body);
    expect(second.status).toBe(200);

    // Still confirmed, still paid, and exactly ONE event recorded.
    expect(await statusOfBooking(bookingId)).toBe('confirmed');
    expect((await rowOfPayment(orderId)).status).toBe('paid');
    expect(await eventsForBooking(bookingId)).toHaveLength(1);
  });

  // --- AC #2: two concurrent deliveries → one applies, one no-ops -------------

  it('lets exactly one of two concurrent deliveries apply (unique decides)', async () => {
    const { bookingId, orderId } = await seedPayable();
    const body = settlement(orderId);

    const [a, b] = await Promise.all([
      deliver('midtrans', body),
      deliver('midtrans', body),
    ]);
    // Both return 200 - the loser's "already processed" is not an error.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // The end state proves the constraint arbitrated: one confirm, one event.
    expect(await statusOfBooking(bookingId)).toBe('confirmed');
    expect((await rowOfPayment(orderId)).status).toBe('paid');
    expect(await eventsForBooking(bookingId)).toHaveLength(1);
  });

  // --- AC #3: bad signature → 401; unknown provider → 404; failure → failed ---

  it('401s a bad signature and changes nothing', async () => {
    const { bookingId, orderId } = await seedPayable();
    const res = await deliver(
      'midtrans',
      settlement(orderId, { signatureValid: false }),
    );
    expect(res.status).toBe(401);
    expect(await statusOfBooking(bookingId)).toBe('pending_payment');
    expect((await rowOfPayment(orderId)).status).toBe('pending');
    expect(await eventsForBooking(bookingId)).toHaveLength(0);
  });

  it('404s an unknown provider', async () => {
    const { orderId } = await seedPayable();
    const res = await deliver('paypal', settlement(orderId));
    expect(res.status).toBe(404);
  });

  it('marks the payment failed on a failure event; the hold keeps ticking', async () => {
    const { bookingId, orderId } = await seedPayable();
    const res = await deliver('midtrans', {
      ...settlement(orderId),
      transactionStatus: 'expire',
    });
    expect(res.status).toBe(200);

    expect((await rowOfPayment(orderId)).status).toBe('failed');
    // Booking untouched - it stays pending_payment until the sweeper expires it.
    expect(await statusOfBooking(bookingId)).toBe('pending_payment');
    expect(await eventsForBooking(bookingId)).toHaveLength(1);
  });

  // --- AC #4: crash between event insert and state change replays -------------

  it('rolls back the event insert if the state change crashes, then replays', async () => {
    const { bookingId, orderId } = await seedPayable();
    const body = settlement(orderId);

    // Fault the transition AFTER the event insert, inside the same transaction.
    const spy = jest.spyOn(svc, 'applyOutcome').mockImplementationOnce(() => {
      throw new Error('simulated crash between insert and state change');
    });

    await expect(svc.handle('midtrans', body)).rejects.toThrow(
      'simulated crash',
    );

    // The transaction rolled back BOTH the event insert and any state change:
    // nothing recorded, nothing confirmed - so the redelivery is not a duplicate.
    expect(await eventsForBooking(bookingId)).toHaveLength(0);
    expect(await statusOfBooking(bookingId)).toBe('pending_payment');
    expect((await rowOfPayment(orderId)).status).toBe('pending');

    // Provider redelivers the SAME event; now it applies cleanly.
    spy.mockRestore();
    const res = await deliver('midtrans', body);
    expect(res.status).toBe(200);
    expect(await statusOfBooking(bookingId)).toBe('confirmed');
    expect((await rowOfPayment(orderId)).status).toBe('paid');
    expect(await eventsForBooking(bookingId)).toHaveLength(1);
  });

  // --- Domain edges beyond the ACs -------------------------------------------

  it('records a pending event without changing state', async () => {
    const { bookingId, orderId } = await seedPayable();
    const res = await deliver('midtrans', {
      ...settlement(orderId),
      transactionStatus: 'pending',
    });
    expect(res.status).toBe(200);
    expect(await statusOfBooking(bookingId)).toBe('pending_payment');
    expect((await rowOfPayment(orderId)).status).toBe('pending');
    expect(await eventsForBooking(bookingId)).toHaveLength(1);
  });

  it('never resurrects an expired booking on a late settlement (records paid)', async () => {
    const bookingId = await seedBooking({
      status: 'expired',
      holdExpiresAt: new Date(Date.now() - 60_000),
    });
    const orderId = await seedPayment(bookingId);

    const res = await deliver('midtrans', settlement(orderId));
    expect(res.status).toBe(200);

    // Money is recorded, but the booking is NOT dragged back to confirmed.
    expect((await rowOfPayment(orderId)).status).toBe('paid');
    expect(await statusOfBooking(bookingId)).toBe('expired');
  });

  it('does not confirm when the settled amount mismatches the snapshot', async () => {
    const { bookingId, orderId } = await seedPayable(4_000_000n);
    const res = await deliver(
      'midtrans',
      settlement(orderId, { grossAmountIdr: 3_000_000 }),
    );
    expect(res.status).toBe(200);

    // The mismatch is recorded (so a redelivery no-ops) but nothing transitions.
    expect(await statusOfBooking(bookingId)).toBe('pending_payment');
    expect((await rowOfPayment(orderId)).status).toBe('pending');
    expect(await eventsForBooking(bookingId)).toHaveLength(1);
  });

  it('200-acks a verified event for an unknown order and records nothing', async () => {
    const res = await deliver('midtrans', settlement(randomUUID()));
    expect(res.status).toBe(200);
  });

  it('400s a malformed body', async () => {
    const res = await deliver('midtrans', { not: 'a webhook' });
    expect(res.status).toBe(400);
  });
});
