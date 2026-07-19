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
  BookingDetail,
  CancelBookingResponse,
  CreateOwnerBookingResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { testSlug } from '../test-helpers';

/**
 * Owner-side booking operations - POST /bookings (manual block / walk-in),
 * GET /bookings/:id (detail), POST /bookings/:id/cancel (FSM) (api-spec §5.4-5.7,
 * #50, ADR-0011). "The owner is an authority, not a customer": the write shares
 * the guest funnel's overlap chokepoint but SKIPS the guest-protection policy
 * checks (min_stay, max_guests). These tests exercise exactly that split, the FSM
 * cancel, and tenant isolation (the reason this is a reviewed tenant-data change).
 *
 * Real Postgres (needs `docker compose up`): the overlap guard is the exclusion
 * constraint, the cancel FSM is a guarded UPDATE, and isolation is RLS + WHERE -
 * none of which a mock could prove.
 */
describe('Owner bookings (block / walk-in / detail / cancel)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  let tokenA: string;
  let tenantAId: string;
  let tenantBId: string;

  // A / property 1: unitStd (price 1,000,000, minStay 2, maxGuests 2), unitArchived.
  let propAId: string;
  let unitStdId: string;
  let unitArchivedId: string;
  let unitBId: string; // tenant B's unit - A must never touch it

  const createAs = (token: string, body: Record<string, unknown>) =>
    request(server())
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const getAs = (token: string, id: string) =>
    request(server())
      .get(`/api/bookings/${id}`)
      .set('Authorization', `Bearer ${token}`);

  const cancelAs = (token: string, id: string) =>
    request(server())
      .post(`/api/bookings/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`);

  /** Plant a booking directly (owner connection, bypasses RLS) - the only way to
   * seed another tenant's rows, a lapsed hold, or an already-expired booking. */
  const seed = (values: {
    tenantId: string;
    unitId: string;
    status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
    checkIn: string;
    checkOut: string;
    source?: 'direct' | 'manual_block';
    holdExpiresAt?: Date;
  }) =>
    dbs.db
      .insert(booking)
      .values({
        tenantId: values.tenantId,
        unitId: values.unitId,
        source: values.source ?? 'manual_block',
        status: values.status,
        checkIn: values.checkIn,
        checkOut: values.checkOut,
        holdExpiresAt: values.holdExpiresAt ?? null,
      })
      .returning({ id: booking.id })
      .then((rows) => rows[0].id);

  const rowById = async (id: string) => {
    const [row] = await dbs.db.select().from(booking).where(eq(booking.id, id));
    return row;
  };

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
          email: `owner+${randomUUID()}@test.dev`,
          password: 'supersecret1',
        });
      return bodyOf<AuthResponse>(res);
    };

    const a = await registerTenant('Owner Tenant A');
    const b = await registerTenant('Owner Tenant B');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;
    createdTenantIds.push(tenantAId, tenantBId);

    const [pA, pB] = await dbs.db
      .insert(property)
      .values([
        { tenantId: tenantAId, name: 'Owner Villa A', slug: testSlug() },
        { tenantId: tenantBId, name: 'Owner Villa B', slug: testSlug() },
      ])
      .returning({ id: property.id });
    propAId = pA.id;

    const [std, archived, uB] = await dbs.db
      .insert(unit)
      .values([
        {
          propertyId: pA.id,
          tenantId: tenantAId,
          name: 'Standard Room',
          basePriceIdr: 1_000_000n,
          minStay: 2,
          maxGuests: 2,
        },
        {
          propertyId: pA.id,
          tenantId: tenantAId,
          name: 'Retired Room',
          basePriceIdr: 1_000_000n,
          archivedAt: new Date('2026-07-01T00:00:00Z'),
        },
        {
          propertyId: pB.id,
          tenantId: tenantBId,
          name: 'B Room',
          basePriceIdr: 1_000_000n,
        },
      ])
      .returning({ id: unit.id });
    unitStdId = std.id;
    unitArchivedId = archived.id;
    unitBId = uB.id;
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  // --- POST /bookings: manual block ----------------------------------------

  it('creates a manual_block: confirmed, no guest, no price, no hold', async () => {
    const res = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-01-10',
      checkOut: '2028-01-14',
    });
    expect(res.status).toBe(201);
    const b = bodyOf<CreateOwnerBookingResponse>(res);
    expect(b.status).toBe('confirmed');
    expect(b.source).toBe('manual_block');
    expect(b.totalPriceIdr).toBeNull();
    expect(b.nights).toBe(4);

    const row = await rowById(b.bookingId);
    expect(row.tenantId).toBe(tenantAId);
    expect(row.guestName).toBeNull();
    expect(row.totalPriceIdr).toBeNull();
    expect(row.holdExpiresAt).toBeNull();
  });

  it('blocks guest availability immediately (AC #1): a public quote sees it', async () => {
    await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-02-10',
      checkOut: '2028-02-14',
    });
    // The public availability read is the guest's view - the block must show up.
    const res = await request(server()).get(
      `/api/public/units/${unitStdId}/availability?from=2028-02-10&to=2028-02-14`,
    );
    expect(res.status).toBe(200);
    const q = bodyOf<{ available: boolean; blockedRanges: unknown[] }>(res);
    expect(q.available).toBe(false);
    expect(q.blockedRanges.length).toBeGreaterThan(0);
  });

  // --- POST /bookings: walk-in ---------------------------------------------

  it('creates a walk-in (source=direct) confirmed, price = base x nights by default', async () => {
    const res = await createAs(tokenA, {
      source: 'direct',
      unitId: unitStdId,
      checkIn: '2028-03-10',
      checkOut: '2028-03-14',
      guestName: 'Walk In Wendy',
      guestPhone: '+62 812 0000 1111',
      guestCount: 2,
    });
    expect(res.status).toBe(201);
    const b = bodyOf<CreateOwnerBookingResponse>(res);
    expect(b.status).toBe('confirmed');
    expect(b.source).toBe('direct');
    expect(b.totalPriceIdr).toBe(4_000_000); // 1,000,000 x 4, server default

    const row = await rowById(b.bookingId);
    expect(row.guestName).toBe('Walk In Wendy');
    expect(row.holdExpiresAt).toBeNull();
  });

  it('honours an owner price override on a walk-in', async () => {
    const res = await createAs(tokenA, {
      source: 'direct',
      unitId: unitStdId,
      checkIn: '2028-03-20',
      checkOut: '2028-03-24',
      guestName: 'Discount Dan',
      totalPriceIdr: 3_000_000, // negotiated cash rate, below the 4,000,000 default
    });
    expect(res.status).toBe(201);
    expect(bodyOf<CreateOwnerBookingResponse>(res).totalPriceIdr).toBe(
      3_000_000,
    );
  });

  it('requires a guest name for a walk-in but not for a block (AC #2)', async () => {
    const noName = await createAs(tokenA, {
      source: 'direct',
      unitId: unitStdId,
      checkIn: '2028-04-10',
      checkOut: '2028-04-14',
    });
    expect(noName.status).toBe(400);

    const block = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-04-10',
      checkOut: '2028-04-14',
    });
    expect(block.status).toBe(201);
  });

  // --- The authority/policy split (ADR-0011) -------------------------------

  it('lets the owner block a SINGLE night on a minStay=2 unit (min_stay skipped)', async () => {
    const res = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-05-10',
      checkOut: '2028-05-11', // 1 night < minStay 2 - a guest would 409
    });
    expect(res.status).toBe(201);
  });

  it('lets the owner record a walk-in over unit capacity (max_guests skipped)', async () => {
    const res = await createAs(tokenA, {
      source: 'direct',
      unitId: unitStdId,
      checkIn: '2028-05-20',
      checkOut: '2028-05-24',
      guestName: 'Big Family',
      guestCount: 5, // maxGuests is 2 - a guest would 409
    });
    expect(res.status).toBe(201);
  });

  // --- Overlap: the ONE guard the owner still obeys (AC #4) -----------------

  it('refuses an overlapping manual create with the SAME 409 as the guest flow', async () => {
    await seed({
      tenantId: tenantAId,
      unitId: unitStdId,
      status: 'confirmed',
      checkIn: '2028-06-10',
      checkOut: '2028-06-14',
    });
    const res = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-06-12',
      checkOut: '2028-06-16',
    });
    expect(res.status).toBe(409);
    expect(bodyOf<{ reasons: string[] }>(res).reasons).toEqual(['overlap']);
  });

  it('lets the changeover day rebook (half-open): a checkout is the next check-in', async () => {
    const first = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-07-10',
      checkOut: '2028-07-13',
    });
    expect(first.status).toBe(201);
    const next = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-07-13',
      checkOut: '2028-07-16',
    });
    expect(next.status).toBe(201);
  });

  it('opportunistically frees a lapsed hold, so the owner can block the dates', async () => {
    const lapsedId = await seed({
      tenantId: tenantAId,
      unitId: unitStdId,
      status: 'pending_payment',
      source: 'direct',
      checkIn: '2028-08-10',
      checkOut: '2028-08-14',
      holdExpiresAt: new Date(Date.now() - 60_000),
    });
    const res = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-08-10',
      checkOut: '2028-08-14',
    });
    expect(res.status).toBe(201);
    expect((await rowById(lapsedId)).status).toBe('expired');
  });

  // --- Archived + unknown + cross-tenant ------------------------------------

  it('refuses a create on an archived unit as `archived` (owner sees the real word)', async () => {
    const res = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitArchivedId,
      checkIn: '2028-01-10',
      checkOut: '2028-01-14',
    });
    expect(res.status).toBe(409);
    expect(bodyOf<{ reasons: string[] }>(res).reasons).toEqual(['archived']);
  });

  it('404s an unknown unit id', async () => {
    const res = await createAs(tokenA, {
      source: 'manual_block',
      unitId: randomUUID(),
      checkIn: '2028-01-10',
      checkOut: '2028-01-14',
    });
    expect(res.status).toBe(404);
  });

  it("404s another tenant's unit (never creates cross-tenant)", async () => {
    const res = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitBId,
      checkIn: '2028-01-10',
      checkOut: '2028-01-14',
    });
    expect(res.status).toBe(404);
  });

  // --- GET /bookings/:id ----------------------------------------------------

  it('returns full detail for an own booking (owner disclosure)', async () => {
    const created = await createAs(tokenA, {
      source: 'direct',
      unitId: unitStdId,
      checkIn: '2028-09-10',
      checkOut: '2028-09-14',
      guestName: 'Detail Dana',
      guestPhone: '+62 813 2222 3333',
      guestEmail: 'dana@example.com',
      guestCount: 2,
    });
    const { bookingId } = bodyOf<CreateOwnerBookingResponse>(created);

    const res = await getAs(tokenA, bookingId);
    expect(res.status).toBe(200);
    const d = bodyOf<BookingDetail>(res);
    expect(d.id).toBe(bookingId);
    expect(d.guestName).toBe('Detail Dana');
    expect(d.guestPhone).toBe('+62 813 2222 3333');
    expect(d.guestEmail).toBe('dana@example.com');
    expect(d.propertyId).toBe(propAId);
    expect(d.propertyName).toBe('Owner Villa A');
    expect(d.unitName).toBe('Standard Room');
  });

  it('404s an unknown booking id and a cross-tenant one (404-over-403)', async () => {
    const unknown = await getAs(tokenA, randomUUID());
    expect(unknown.status).toBe(404);

    const bId = await seed({
      tenantId: tenantBId,
      unitId: unitBId,
      status: 'confirmed',
      checkIn: '2028-10-10',
      checkOut: '2028-10-14',
    });
    const cross = await getAs(tokenA, bId);
    expect(cross.status).toBe(404);
  });

  // --- POST /bookings/:id/cancel (FSM) --------------------------------------

  it('cancels a confirmed booking, frees the dates instantly, refund none', async () => {
    const created = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-11-10',
      checkOut: '2028-11-14',
    });
    const { bookingId } = bodyOf<CreateOwnerBookingResponse>(created);

    const res = await cancelAs(tokenA, bookingId);
    expect(res.status).toBe(200);
    const c = bodyOf<CancelBookingResponse>(res);
    expect(c.status).toBe('cancelled');
    expect(c.refund).toBe('none');
    expect((await rowById(bookingId)).status).toBe('cancelled');

    // Dates are free again: the same nights book without a 409.
    const rebook = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-11-10',
      checkOut: '2028-11-14',
    });
    expect(rebook.status).toBe(201);
  });

  it('refuses a second cancel with a 409 naming the terminal state (FSM)', async () => {
    const created = await createAs(tokenA, {
      source: 'manual_block',
      unitId: unitStdId,
      checkIn: '2028-12-10',
      checkOut: '2028-12-14',
    });
    const { bookingId } = bodyOf<CreateOwnerBookingResponse>(created);

    expect((await cancelAs(tokenA, bookingId)).status).toBe(200);
    const second = await cancelAs(tokenA, bookingId);
    expect(second.status).toBe(409);
    // Slug names the conflict; the terminal `status` rides as data (#82).
    expect(bodyOf<{ code: string; status: string }>(second)).toMatchObject({
      code: 'booking_not_cancellable',
      status: 'cancelled',
    });
  });

  it('refuses cancelling an already-expired booking with a 409', async () => {
    const expiredId = await seed({
      tenantId: tenantAId,
      unitId: unitStdId,
      status: 'expired',
      source: 'direct',
      checkIn: '2029-01-10',
      checkOut: '2029-01-14',
    });
    const res = await cancelAs(tokenA, expiredId);
    expect(res.status).toBe(409);
    expect(bodyOf<{ status: string }>(res).status).toBe('expired');
  });

  it('404s cancelling an unknown or cross-tenant booking (no cross-tenant write)', async () => {
    expect((await cancelAs(tokenA, randomUUID())).status).toBe(404);

    const bId = await seed({
      tenantId: tenantBId,
      unitId: unitBId,
      status: 'confirmed',
      checkIn: '2029-02-10',
      checkOut: '2029-02-14',
    });
    expect((await cancelAs(tokenA, bId)).status).toBe(404);
    // And tenant B's booking is untouched.
    expect((await rowById(bId)).status).toBe('confirmed');
  });

  it('marks the refund manual when cancelling a paid booking (AC #3)', async () => {
    // The only path to a paid booking at M2 is a seeded payment row - there is no
    // pay endpoint until M3. Prove the branch anyway: the AC names it explicitly.
    const paidId = await seed({
      tenantId: tenantAId,
      unitId: unitStdId,
      status: 'confirmed',
      source: 'direct',
      checkIn: '2029-03-10',
      checkOut: '2029-03-14',
    });
    await dbs.db.insert(payment).values({
      bookingId: paidId,
      provider: 'midtrans',
      amountIdr: 4_000_000n,
      status: 'paid',
    });

    const res = await cancelAs(tokenA, paidId);
    expect(res.status).toBe(200);
    const c = bodyOf<CancelBookingResponse>(res);
    expect(c.status).toBe('cancelled');
    expect(c.refund).toBe('manual');
  });
});
