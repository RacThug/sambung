import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { booking, payment, property, tenant, unit } from '@sambung/db';
import type {
  AuthResponse,
  BookingStatus,
  LapsedPayment,
  MarkPaymentHandledResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { testSlug } from '../test-helpers';

/**
 * The owner's paid-but-lapsed payment inbox - GET /payments/lapsed +
 * POST /payments/:id/handle (#120, ADR-0022). The late-settlement case boss fight
 * #4 handles silently (ADR-0018): the guest settles after the hold lapsed/was
 * cancelled, so `payment.status = paid` while `booking.status IN (expired,
 * cancelled)`. This is a NEW owner-facing read over payment+booking data, so the
 * suite proves both ACs AND tenant isolation - a reviewer WILL try to read/handle
 * another tenant's paid-but-lapsed rows.
 *
 * Real Postgres (needs `docker compose up`): isolation is RLS + the `tenant_id`
 * join, and "handle touches only the marker" is a real UPDATE - neither a mock
 * could prove. Fixtures are planted on the owner connection (RLS off), the only
 * way to seed another tenant's rows and an arbitrary paid/expired combination.
 */
describe('Paid-but-lapsed payment inbox (#120)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  let tokenA: string;
  let tenantAId: string;
  let tokenB: string;
  let tenantBId: string;
  let unitAId: string;
  let unitBId: string;

  const listAs = (token: string) =>
    request(server())
      .get('/api/payments/lapsed')
      .set('Authorization', `Bearer ${token}`);

  const handleAs = (token: string, id: string) =>
    request(server())
      .post(`/api/payments/${id}/handle`)
      .set('Authorization', `Bearer ${token}`);

  // Distinct dates per seed so occupying rows (confirmed) never collide on the
  // exclusion constraint - the suite shares units and never cleans up between tests.
  let stayOffset = 0;
  const uniqueStay = (): { checkIn: string; checkOut: string } => {
    const start = new Date(Date.UTC(2030, 0, 5 + stayOffset));
    stayOffset += 6;
    const end = new Date(start.getTime() + 3 * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { checkIn: iso(start), checkOut: iso(end) };
  };

  /** Plant a booking + a payment directly (owner connection, bypasses RLS). Defaults
   * describe the inbox case: a `paid` payment on an `expired` booking, unhandled. */
  const seedPayment = async (values: {
    tenantId: string;
    unitId: string;
    bookingStatus?: BookingStatus;
    paymentStatus?: 'pending' | 'paid' | 'failed';
    amountIdr?: bigint;
    handledAt?: Date | null;
    guestName?: string | null;
  }): Promise<{ bookingId: string; paymentId: string }> => {
    const { checkIn, checkOut } = uniqueStay();
    const [b] = await dbs.db
      .insert(booking)
      .values({
        tenantId: values.tenantId,
        unitId: values.unitId,
        source: 'direct',
        status: values.bookingStatus ?? 'expired',
        checkIn,
        checkOut,
        guestName:
          values.guestName === undefined ? 'Lapsed Larry' : values.guestName,
        guestPhone: '+62 811 2233 4455',
        guestEmail: 'larry@example.com',
        guestCount: 2,
        totalPriceIdr: 4_000_000n,
        holdExpiresAt: null,
      })
      .returning({ id: booking.id });
    const [p] = await dbs.db
      .insert(payment)
      .values({
        bookingId: b.id,
        provider: 'midtrans',
        amountIdr: values.amountIdr ?? 4_000_000n,
        status: values.paymentStatus ?? 'paid',
        handledAt: values.handledAt ?? null,
      })
      .returning({ id: payment.id });
    return { bookingId: b.id, paymentId: p.id };
  };

  const paymentRow = async (id: string) =>
    (await dbs.db.select().from(payment).where(eq(payment.id, id)))[0];
  const bookingRow = async (id: string) =>
    (await dbs.db.select().from(booking).where(eq(booking.id, id)))[0];
  const idsIn = (list: LapsedPayment[]) => list.map((p) => p.paymentId);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);

    const registerTenant = async (name: string) => {
      const res = await request(server())
        .post('/api/auth/register')
        .send({
          tenantName: name,
          email: `inbox+${randomUUID()}@test.dev`,
          password: 'supersecret1',
        });
      return bodyOf<AuthResponse>(res);
    };

    const a = await registerTenant('Inbox Tenant A');
    const b = await registerTenant('Inbox Tenant B');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    tokenB = b.accessToken;
    tenantBId = b.tenant.id;
    createdTenantIds.push(tenantAId, tenantBId);

    const [pA, pB] = await dbs.db
      .insert(property)
      .values([
        { tenantId: tenantAId, name: 'Inbox Villa A', slug: testSlug() },
        { tenantId: tenantBId, name: 'Inbox Villa B', slug: testSlug() },
      ])
      .returning({ id: property.id });

    const [uA, uB] = await dbs.db
      .insert(unit)
      .values([
        {
          propertyId: pA.id,
          tenantId: tenantAId,
          name: 'A Room',
          basePriceIdr: 1_000_000n,
        },
        {
          propertyId: pB.id,
          tenantId: tenantBId,
          name: 'B Room',
          basePriceIdr: 1_000_000n,
        },
      ])
      .returning({ id: unit.id });
    unitAId = uA.id;
    unitBId = uB.id;
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  // --- AC (a): sees paid payments whose booking is not confirmed -------------

  it('lists a paid payment on an expired booking, with enough to act', async () => {
    const { paymentId, bookingId } = await seedPayment({
      tenantId: tenantAId,
      unitId: unitAId,
      bookingStatus: 'expired',
      guestName: 'Expired Ellie',
    });

    const res = await listAs(tokenA);
    expect(res.status).toBe(200);
    const item = bodyOf<LapsedPayment[]>(res).find(
      (p) => p.paymentId === paymentId,
    );
    // Enough to act: amount (integer rupiah, not float), guest, dates, where, why.
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      bookingId,
      bookingStatus: 'expired',
      provider: 'midtrans',
      amountIdr: 4_000_000,
      guestName: 'Expired Ellie',
      guestPhone: '+62 811 2233 4455',
      guestEmail: 'larry@example.com',
      propertyName: 'Inbox Villa A',
      unitName: 'A Room',
    });
    expect(item?.checkIn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item?.checkOut).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('lists a paid payment on a cancelled booking too', async () => {
    const { paymentId } = await seedPayment({
      tenantId: tenantAId,
      unitId: unitAId,
      bookingStatus: 'cancelled',
    });
    const res = await listAs(tokenA);
    expect(idsIn(bodyOf<LapsedPayment[]>(res))).toContain(paymentId);
  });

  it('excludes a paid payment whose booking is CONFIRMED (not lapsed)', async () => {
    const { paymentId } = await seedPayment({
      tenantId: tenantAId,
      unitId: unitAId,
      bookingStatus: 'confirmed',
    });
    const res = await listAs(tokenA);
    expect(idsIn(bodyOf<LapsedPayment[]>(res))).not.toContain(paymentId);
  });

  it('excludes a PENDING payment on an expired booking (money not captured)', async () => {
    const { paymentId } = await seedPayment({
      tenantId: tenantAId,
      unitId: unitAId,
      bookingStatus: 'expired',
      paymentStatus: 'pending',
    });
    const res = await listAs(tokenA);
    expect(idsIn(bodyOf<LapsedPayment[]>(res))).not.toContain(paymentId);
  });

  it('excludes an already-handled paid-but-lapsed payment', async () => {
    const { paymentId } = await seedPayment({
      tenantId: tenantAId,
      unitId: unitAId,
      bookingStatus: 'expired',
      handledAt: new Date('2030-01-01T00:00:00Z'),
    });
    const res = await listAs(tokenA);
    expect(idsIn(bodyOf<LapsedPayment[]>(res))).not.toContain(paymentId);
  });

  // --- AC (b): mark handled removes it WITHOUT touching the ledger -----------

  it('marks one handled: it drops from the list and the ledger is untouched', async () => {
    const { paymentId, bookingId } = await seedPayment({
      tenantId: tenantAId,
      unitId: unitAId,
      bookingStatus: 'cancelled',
    });
    // It starts in the inbox.
    expect(idsIn(bodyOf<LapsedPayment[]>(await listAs(tokenA)))).toContain(
      paymentId,
    );

    const res = await handleAs(tokenA, paymentId);
    expect(res.status).toBe(200);
    const body = bodyOf<MarkPaymentHandledResponse>(res);
    expect(body.paymentId).toBe(paymentId);
    expect(new Date(body.handledAt).getTime()).toBeGreaterThan(0);

    // Gone from the inbox.
    expect(idsIn(bodyOf<LapsedPayment[]>(await listAs(tokenA)))).not.toContain(
      paymentId,
    );

    // THE LEDGER IS UNTOUCHED: only handled_at changed. Payment still `paid`, its
    // amount intact; the booking still `cancelled` (never resurrected). (ADR-0002)
    const pay = await paymentRow(paymentId);
    expect(pay.status).toBe('paid');
    expect(pay.amountIdr).toBe(4_000_000n);
    expect(pay.handledAt).not.toBeNull();
    expect((await bookingRow(bookingId)).status).toBe('cancelled');
  });

  it('is idempotent: handling an already-handled item is a 200 no-op', async () => {
    const { paymentId } = await seedPayment({
      tenantId: tenantAId,
      unitId: unitAId,
      bookingStatus: 'expired',
    });
    const first = await handleAs(tokenA, paymentId);
    expect(first.status).toBe(200);
    const firstAt = bodyOf<MarkPaymentHandledResponse>(first).handledAt;

    const second = await handleAs(tokenA, paymentId);
    expect(second.status).toBe(200);
    // Same handled_at both times - the second click didn't re-stamp it.
    expect(bodyOf<MarkPaymentHandledResponse>(second).handledAt).toBe(firstAt);
  });

  it('404s handling an unknown id', async () => {
    expect((await handleAs(tokenA, randomUUID())).status).toBe(404);
  });

  it('404s handling a payment that is not an inbox item (booking confirmed)', async () => {
    const { paymentId } = await seedPayment({
      tenantId: tenantAId,
      unitId: unitAId,
      bookingStatus: 'confirmed',
    });
    const res = await handleAs(tokenA, paymentId);
    expect(res.status).toBe(404);
    // ...and nothing was marked - the guard refused, no write happened.
    expect((await paymentRow(paymentId)).handledAt).toBeNull();
  });

  it('400s a non-UUID id at the boundary', async () => {
    expect((await handleAs(tokenA, 'not-a-uuid')).status).toBe(400);
  });

  // --- Tenant isolation (the reviewer's target) ------------------------------

  it("never lists another tenant's paid-but-lapsed payment", async () => {
    const { paymentId: bPaymentId } = await seedPayment({
      tenantId: tenantBId,
      unitId: unitBId,
      bookingStatus: 'expired',
    });
    // B sees its own...
    expect(idsIn(bodyOf<LapsedPayment[]>(await listAs(tokenB)))).toContain(
      bPaymentId,
    );
    // ...A must not.
    expect(idsIn(bodyOf<LapsedPayment[]>(await listAs(tokenA)))).not.toContain(
      bPaymentId,
    );
  });

  it("404s handling another tenant's payment, and never mutates it", async () => {
    const { paymentId: bPaymentId } = await seedPayment({
      tenantId: tenantBId,
      unitId: unitBId,
      bookingStatus: 'cancelled',
    });

    const res = await handleAs(tokenA, bPaymentId);
    // Cross-tenant id is invisible under RLS AND fails the tenant_id join → 404.
    expect(res.status).toBe(404);
    // B's payment is completely untouched - still unhandled, still in B's inbox.
    expect((await paymentRow(bPaymentId)).handledAt).toBeNull();
    expect(idsIn(bodyOf<LapsedPayment[]>(await listAs(tokenB)))).toContain(
      bPaymentId,
    );
  });

  it('requires auth (no token → 401)', async () => {
    expect((await request(server()).get('/api/payments/lapsed')).status).toBe(
      401,
    );
  });
});
