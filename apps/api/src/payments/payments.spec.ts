import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { booking, payment, property, tenant, unit } from '@sambung/db';
import type { AuthResponse, PaymentSessionResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { testSlug } from '../test-helpers';
import { FakePaymentGateway } from './fake-payment.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';

/**
 * The pay step - `POST /public/bookings/:id/pay` (api-spec §6.1, #52, ADR-0015).
 *
 * Real Postgres so RLS, the booking-scoped payment policy, the hold sweep and the
 * FOR UPDATE lock are all genuinely exercised - but the Provider is a fake bound
 * over PAYMENT_GATEWAY, so no test reaches live Midtrans (AC #3). The fake echoes
 * the order id into its token, which is how these prove `order_id = payment.id`.
 */
describe('Payment session (pay step)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const fake = new FakePaymentGateway();
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  let tenantAId: string;
  let unitFullId: string; // property deposit_pct = 100 (pay in full)
  let unitHalfId: string; // property deposit_pct = 50 (partial deposit)

  const pay = (id: string) =>
    request(server()).post(`/api/public/bookings/${id}/pay`);

  // Each seed uses its OWN dates so occupying rows never collide on the exclusion
  // constraint - the tests share one unit and never clean up between them. Date
  // arithmetic (not string math) so the offset can cross month boundaries safely.
  let stayOffset = 0;
  const uniqueStay = (): { checkIn: string; checkOut: string } => {
    const start = new Date(Date.UTC(2027, 0, 10 + stayOffset));
    stayOffset += 6;
    const end = new Date(start.getTime() + 4 * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { checkIn: iso(start), checkOut: iso(end) };
  };

  /** Seed a booking directly (owner connection, bypasses RLS). A guest hold has a
   * price (4,000,000 = 4 nights x 1,000,000) and a future TTL; overrides make it
   * lapsed / confirmed. Distinct dates per call keep occupying rows from clashing. */
  const seedBooking = (values: {
    unitId: string;
    status?: 'pending_payment' | 'confirmed';
    totalPriceIdr?: bigint | null;
    holdExpiresAt?: Date | null;
    source?: 'direct' | 'manual_block';
  }) => {
    const { checkIn, checkOut } = uniqueStay();
    return dbs.db
      .insert(booking)
      .values({
        tenantId: tenantAId,
        unitId: values.unitId,
        source: values.source ?? 'direct',
        status: values.status ?? 'pending_payment',
        checkIn,
        checkOut, // 4 nights
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

  const paymentsFor = (bookingId: string) =>
    dbs.db.select().from(payment).where(eq(payment.bookingId, bookingId));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The whole point of the port: swap the Provider for a fake, so the suite
      // runs end-to-end with no live Midtrans (AC #3).
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);

    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: 'Pay Tenant A',
        email: `pay+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    tenantAId = bodyOf<AuthResponse>(res).tenant.id;
    createdTenantIds.push(tenantAId);

    const [propFull, propHalf] = await dbs.db
      .insert(property)
      .values([
        {
          tenantId: tenantAId,
          name: 'Full Villa',
          slug: testSlug(),
          depositPct: 100,
        },
        {
          tenantId: tenantAId,
          name: 'Half Villa',
          slug: testSlug(),
          depositPct: 50,
        },
      ])
      .returning({ id: property.id });

    const [uFull, uHalf] = await dbs.db
      .insert(unit)
      .values([
        {
          propertyId: propFull.id,
          tenantId: tenantAId,
          name: 'Full Room',
          basePriceIdr: 1_000_000n,
        },
        {
          propertyId: propHalf.id,
          tenantId: tenantAId,
          name: 'Half Room',
          basePriceIdr: 1_000_000n,
        },
      ])
      .returning({ id: unit.id });
    unitFullId = uFull.id;
    unitHalfId = uHalf.id;
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  // --- AC #1: pay creates the session; amount = deposit % of total ----------

  it('creates a Provider session charging the full total at 100% deposit', async () => {
    const id = await seedBooking({ unitId: unitFullId });
    const res = await pay(id);
    expect(res.status).toBe(201);

    const b = bodyOf<PaymentSessionResponse>(res);
    expect(b.provider).toBe('midtrans');
    expect(b.amountIdr).toBe(4_000_000); // 100% of 4,000,000
    expect(b.deposit).toBe(false); // full payment, not a partial deposit
    expect(b.redirectUrl).toMatch(/^https:\/\//);
    expect(b.token).toBeTruthy();

    // One pending payment row, amount snapshotted, session stored, provider_ref =
    // the payment id (the order id #53's webhook resolves the booking by).
    const rows = await paymentsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].amountIdr).toBe(4_000_000n);
    expect(rows[0].providerRef).toBe(rows[0].id);
    // The fake echoes the order id into its token, proving order_id = payment.id.
    expect(b.token).toBe(`fake-token-${rows[0].id}`);
    expect(rows[0].rawPayload).toMatchObject({
      token: b.token,
      redirectUrl: b.redirectUrl,
    });
  });

  it('charges the deposit share (floored) when deposit % < 100', async () => {
    const id = await seedBooking({ unitId: unitHalfId });
    const res = await pay(id);
    expect(res.status).toBe(201);

    const b = bodyOf<PaymentSessionResponse>(res);
    expect(b.amountIdr).toBe(2_000_000); // 50% of 4,000,000
    expect(b.deposit).toBe(true); // partial - balance settles at the property
  });

  // --- AC #2: retry reuses the open session ---------------------------------

  it('reuses the open session on a retry (idempotent - one row, one Provider call)', async () => {
    const id = await seedBooking({ unitId: unitFullId });

    const before = fake.calls.length;
    const first = bodyOf<PaymentSessionResponse>(await pay(id));
    const second = bodyOf<PaymentSessionResponse>(await pay(id));

    // Same session both times, and the Provider was called exactly once.
    expect(second.token).toBe(first.token);
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(fake.calls.length).toBe(before + 1);
    // Still exactly one payment row for the booking.
    expect(await paymentsFor(id)).toHaveLength(1);
  });

  // --- AC #2: wrong status / lapsed hold -> 409 -----------------------------

  it('409s a booking that is already confirmed, with the blocking status', async () => {
    const id = await seedBooking({
      unitId: unitFullId,
      status: 'confirmed',
      holdExpiresAt: null,
    });
    const res = await pay(id);
    expect(res.status).toBe(409);
    expect(bodyOf<{ code: string; status: string }>(res)).toMatchObject({
      code: 'booking_not_payable',
      status: 'confirmed',
    });
    expect(await paymentsFor(id)).toHaveLength(0);
  });

  it('treats a lapsed hold as not payable (post-sweep status) and mints nothing', async () => {
    const id = await seedBooking({
      unitId: unitFullId,
      status: 'pending_payment',
      holdExpiresAt: new Date(Date.now() - 60_000), // lapsed a minute ago
    });
    const res = await pay(id);
    expect(res.status).toBe(409);
    // The in-transaction sweep flips it to `expired`, which is the status the
    // refusal reports - so "hold lapsed" and "wrong status" are one answer.
    expect(bodyOf<{ code: string; status: string }>(res)).toMatchObject({
      code: 'booking_not_payable',
      status: 'expired',
    });
    // No session was minted - the refusal rolled the transaction back. (We do NOT
    // assert the booking's persisted status: the in-txn flip rolls back with the
    // 409, but the cross-tenant backstop sweep may legitimately flip it to expired
    // out-of-band - ADR-0009 - so either value is correct and asserting one races
    // the sweeper another spec drives against the shared database.)
    expect(await paymentsFor(id)).toHaveLength(0);
  });

  // --- Resolver: unknown / malformed id -------------------------------------

  it('404s an unknown booking id', async () => {
    const res = await pay(randomUUID());
    expect(res.status).toBe(404);
  });

  it('400s a non-UUID booking id at the boundary', async () => {
    const res = await pay('not-a-uuid');
    expect(res.status).toBe(400);
  });
});
