import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import { booking, property, tenant, unit } from '@sambung/db';
import type { AuthResponse, BookingRow } from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { testSlug } from '../test-helpers';

/**
 * The authed reservations read - GET /bookings (api-spec §5.5, #49). The one
 * booking-read path (ADR-0010). These tests exercise the seams that make it
 * correct for the unified calendar: TENANT ISOLATION (AC #4 - the reason this is
 * a tenant-data endpoint that must be reviewed), the repeatable `status` filter
 * the calendar uses to select the two occupying statuses, overlap-window
 * semantics including a stay straddling an edge, WHOLE rows (owner sees the real
 * stay, unclipped), the propertyId filter, and check-in sort.
 *
 * Real Postgres (needs `docker compose up`): isolation is an RLS + WHERE tenant_id
 * property, and only a real DB with two tenants can prove tenant A never sees
 * tenant B's rows even when it names B's ids.
 */
describe('GET /bookings (reservations read)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  let tokenA: string;
  let tokenB: string;
  let tenantAId: string;
  let tenantBId: string;

  // Tenant A: two properties (to make propertyId a real filter), each a unit.
  let propA1Id: string;
  let uStdId: string; // A / property 1
  let uOtherId: string; // A / property 2
  let uBId: string; // Tenant B's unit - A must never see its bookings

  /** Seed a booking directly on the owner connection (bypasses RLS), for any
   * tenant/unit - the only way to plant tenant B's rows the isolation test needs. */
  const seed = (values: {
    tenantId: string;
    unitId: string;
    status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
    checkIn: string;
    checkOut: string;
    source?: 'direct' | 'manual_block';
    guestName?: string;
    holdExpiresAt?: Date;
  }) =>
    dbs.db
      .insert(booking)
      .values({
        tenantId: values.tenantId,
        unitId: values.unitId,
        source: values.source ?? 'direct',
        status: values.status,
        checkIn: values.checkIn,
        checkOut: values.checkOut,
        guestName: values.guestName ?? null,
        holdExpiresAt: values.holdExpiresAt ?? null,
      })
      .returning({ id: booking.id })
      .then((rows) => rows[0].id);

  const listAs = (token: string, query: Record<string, unknown> = {}) =>
    request(server())
      .get('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .query(query);

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
          email: `bq+${randomUUID()}@test.dev`,
          password: 'supersecret1',
        });
      return bodyOf<AuthResponse>(res);
    };

    const a = await registerTenant('Query Tenant A');
    const b = await registerTenant('Query Tenant B');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;
    createdTenantIds.push(tenantAId, tenantBId);

    // A: property 1 (uStd) + property 2 (uOther); B: property (uB).
    const [pA1, pA2, pB] = await dbs.db
      .insert(property)
      .values([
        { tenantId: tenantAId, name: 'A Villa One', slug: testSlug() },
        { tenantId: tenantAId, name: 'A Villa Two', slug: testSlug() },
        { tenantId: tenantBId, name: 'B Villa', slug: testSlug() },
      ])
      .returning({ id: property.id });
    propA1Id = pA1.id;

    const [uStd, uOther, uB] = await dbs.db
      .insert(unit)
      .values([
        {
          propertyId: pA1.id,
          tenantId: tenantAId,
          name: 'A1 Room',
          basePriceIdr: 1_000_000n,
        },
        {
          propertyId: pA2.id,
          tenantId: tenantAId,
          name: 'A2 Room',
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
    uStdId = uStd.id;
    uOtherId = uOther.id;
    uBId = uB.id;

    const future = new Date(Date.now() + 60 * 60_000); // live hold, un-sweepable

    await Promise.all([
      // A / uStd: one of each status + a live hold
      seed({
        tenantId: tenantAId,
        unitId: uStdId,
        status: 'confirmed',
        checkIn: '2027-03-10',
        checkOut: '2027-03-14',
        guestName: 'Made A.',
      }),
      seed({
        tenantId: tenantAId,
        unitId: uStdId,
        status: 'pending_payment',
        checkIn: '2027-04-01',
        checkOut: '2027-04-03',
        holdExpiresAt: future,
      }),
      seed({
        tenantId: tenantAId,
        unitId: uStdId,
        status: 'cancelled',
        checkIn: '2027-03-20',
        checkOut: '2027-03-22',
      }),
      seed({
        tenantId: tenantAId,
        unitId: uStdId,
        status: 'expired',
        checkIn: '2027-03-25',
        checkOut: '2027-03-27',
      }),
      // A / uOther (property 2): a confirmed booking
      seed({
        tenantId: tenantAId,
        unitId: uOtherId,
        status: 'confirmed',
        checkIn: '2027-03-11',
        checkOut: '2027-03-13',
      }),
      // B / uB: same dates as A's confirmed - A must never see it
      seed({
        tenantId: tenantBId,
        unitId: uBId,
        status: 'confirmed',
        checkIn: '2027-03-10',
        checkOut: '2027-03-14',
        guestName: 'Someone Else',
      }),
    ]);
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  // --- AC #4: tenant isolation ---------------------------------------------

  it('returns only the caller tenant, never another tenant', async () => {
    const res = await listAs(tokenA);
    expect(res.status).toBe(200);
    const rows = bodyOf<BookingRow[]>(res);
    // Every row is one of A's units; none is B's - even though B has a booking on
    // the very same dates.
    const aUnits = new Set([uStdId, uOtherId]);
    expect(rows.every((r) => aUnits.has(r.unitId))).toBe(true);
    expect(rows.some((r) => r.unitId === uBId)).toBe(false);
  });

  it("cannot reach another tenant's rows even by naming its unit id", async () => {
    // A crafts a request with B's unit id; RLS + the WHERE return nothing, not B's
    // booking. Existence is hidden - an empty list, never a leak (api-spec §1).
    const res = await listAs(tokenA, { unitId: uBId });
    expect(res.status).toBe(200);
    expect(bodyOf<BookingRow[]>(res)).toEqual([]);
  });

  it("tenant B sees B's booking and none of A's", async () => {
    const rows = bodyOf<BookingRow[]>(await listAs(tokenB));
    expect(rows).toHaveLength(1);
    expect(rows[0].unitId).toBe(uBId);
    expect(rows[0].guestName).toBe('Someone Else');
  });

  it('rejects an unauthenticated read with 401', async () => {
    const res = await request(server()).get('/api/bookings');
    expect(res.status).toBe(401);
  });

  // --- The occupying (repeatable status) filter -----------------------------

  it('selects exactly the occupying statuses when the calendar names both', async () => {
    const rows = bodyOf<BookingRow[]>(
      await listAs(tokenA, { status: ['pending_payment', 'confirmed'] }),
    );
    // The cancelled and expired rows are gone; only occupying remain.
    expect(rows.every((r) => r.status !== 'cancelled')).toBe(true);
    expect(rows.every((r) => r.status !== 'expired')).toBe(true);
    expect(rows.some((r) => r.status === 'confirmed')).toBe(true);
    expect(rows.some((r) => r.status === 'pending_payment')).toBe(true);
  });

  it('returns every status when none is named (a neutral list)', async () => {
    const rows = bodyOf<BookingRow[]>(await listAs(tokenA));
    const statuses = new Set(rows.map((r) => r.status));
    // A management list surfaces cancelled/expired too - the calendar filters,
    // the endpoint does not hide.
    expect(statuses.has('cancelled')).toBe(true);
    expect(statuses.has('expired')).toBe(true);
  });

  // --- Overlap window, and WHOLE (unclipped) rows ---------------------------

  it('matches a stay straddling the window, and returns its real unclipped dates', async () => {
    // Window [03-11, 03-13); the confirmed stay [03-10, 03-14) straddles both
    // edges. Overlap semantics match it; the row carries the WHOLE stay, not the
    // window (owner disclosure, unlike the public availability read).
    const rows = bodyOf<BookingRow[]>(
      await listAs(tokenA, {
        from: '2027-03-11',
        to: '2027-03-13',
        unitId: uStdId,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].checkIn).toBe('2027-03-10');
    expect(rows[0].checkOut).toBe('2027-03-14');
    expect(rows[0].guestName).toBe('Made A.'); // whole row, owner sees the guest
  });

  it('excludes a booking wholly outside the window', async () => {
    // The April hold is nowhere near March.
    const rows = bodyOf<BookingRow[]>(
      await listAs(tokenA, {
        from: '2027-03-01',
        to: '2027-03-15',
        unitId: uStdId,
      }),
    );
    expect(rows.some((r) => r.checkIn === '2027-04-01')).toBe(false);
  });

  it('does not match a booking that only touches the window edge (changeover)', async () => {
    // Window ends 03-10; the confirmed stay starts 03-10. Half-open [) - they
    // touch, they do not overlap, the changeover day is bookable.
    const rows = bodyOf<BookingRow[]>(
      await listAs(tokenA, {
        from: '2027-03-05',
        to: '2027-03-10',
        unitId: uStdId,
      }),
    );
    expect(rows).toEqual([]);
  });

  // --- propertyId filter and sort ------------------------------------------

  it('filters to a single property', async () => {
    const rows = bodyOf<BookingRow[]>(
      await listAs(tokenA, { propertyId: propA1Id }),
    );
    // Property 1 holds uStd's four bookings; uOther (property 2) is excluded.
    expect(rows.every((r) => r.unitId === uStdId)).toBe(true);
    expect(rows.some((r) => r.unitId === uOtherId)).toBe(false);
  });

  it('sorts by check-in ascending', async () => {
    const rows = bodyOf<BookingRow[]>(await listAs(tokenA));
    const checkIns = rows.map((r) => r.checkIn);
    expect(checkIns).toEqual([...checkIns].sort());
  });

  // --- Query validation (400s) ---------------------------------------------

  it('rejects a lone `from` without `to` as 400', async () => {
    const res = await listAs(tokenA, { from: '2027-03-01' });
    expect(res.status).toBe(400);
  });

  it('rejects a window longer than the 366-night cap as 400', async () => {
    const res = await listAs(tokenA, { from: '2027-01-01', to: '2028-06-01' });
    expect(res.status).toBe(400);
  });
});
