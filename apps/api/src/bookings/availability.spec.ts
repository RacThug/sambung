import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { inArray } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { booking, property, tenant, unit } from '@sambung/db';
import type { AuthResponse, AvailabilityResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { PublicScope } from '../common/public-scope.service';
import { TenantDbService } from '../db/tenant-db.service';
import { DbService } from '../db/db.service';
import { testSlug } from '../test-helpers';

/**
 * Boss fight #2 - the availability quote (api-spec §5.1, #47). The read side of
 * the calendar: derive the truth about a stay from the occupying booking rows.
 *
 * The interesting cases are the interval semantics (db-design §4.2): a checkout
 * day frees up for the next check-in, a taken window clips to exactly the blocked
 * nights, and none of the booking's source/guest crosses to a Visitor. Occupying
 * bookings are seeded by direct insert - #47 has no booking-write endpoint, that
 * is #48.
 */
describe('Availability quote', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  const quote = (unitId: string, from: string, to: string) =>
    request(server())
      .get(`/api/public/units/${unitId}/availability`)
      .query({ from, to });

  // Tenant A owns the unit under test; tenant B is a neighbour whose bookings
  // must never scope into A's answer.
  let unitAId: string; // price 3_500_000, minStay 2
  let unitZeroId: string; // price 0 (placeholder), active
  let unitOwnArchivedId: string; // archived on its own account
  let unitUnderArchivedPropId: string; // active, but its property is archived
  let unitBId: string;
  const tenantAId = () => createdTenantIds[0];

  async function registerTenant(name: string) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: name,
        email: `avail+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    const auth = bodyOf<AuthResponse>(res);
    createdTenantIds.push(auth.tenant.id);
    return auth;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);

    const a = await registerTenant('Availability Tenant A');
    const b = await registerTenant('Availability Tenant B');

    // --- Tenant A: an active property with the unit under test ------------------
    const [propA] = await dbs.db
      .insert(property)
      .values({ tenantId: a.tenant.id, name: 'Quote Villa', slug: testSlug() })
      .returning({ id: property.id });

    const [unitA, unitZero, unitOwnArchived] = await dbs.db
      .insert(unit)
      .values([
        {
          propertyId: propA.id,
          tenantId: a.tenant.id,
          name: 'Whole Villa',
          basePriceIdr: 3_500_000n,
          minStay: 2,
        },
        {
          propertyId: propA.id,
          tenantId: a.tenant.id,
          name: 'Placeholder Room',
          basePriceIdr: 0n, // storable, never sellable - quotes honestly at 0
          minStay: 1,
        },
        {
          propertyId: propA.id,
          tenantId: a.tenant.id,
          name: 'Retired Room',
          basePriceIdr: 2_000_000n,
          archivedAt: new Date('2026-07-01T00:00:00Z'),
        },
      ])
      .returning({ id: unit.id });
    unitAId = unitA.id;
    unitZeroId = unitZero.id;
    unitOwnArchivedId = unitOwnArchived.id;

    // A whole property retired: its (active) unit must 404 by derivation.
    const [propArchived] = await dbs.db
      .insert(property)
      .values({
        tenantId: a.tenant.id,
        name: 'Retired Villa',
        slug: testSlug(),
        archivedAt: new Date('2026-07-01T00:00:00Z'),
      })
      .returning({ id: property.id });
    const [unitUnderArchived] = await dbs.db
      .insert(unit)
      .values({
        propertyId: propArchived.id,
        tenantId: a.tenant.id,
        name: 'Room in a retired villa',
        basePriceIdr: 1_500_000n,
      })
      .returning({ id: unit.id });
    unitUnderArchivedPropId = unitUnderArchived.id;

    // Occupying bookings on unitA. Two date clusters so each test reads cleanly:
    //   August: one confirmed [08-10,08-13) for the changeover + clip cases,
    //           plus a CANCELLED [08-20,08-23) that must NOT block.
    //   October: two ADJACENT occupying bookings [10-05,10-08)+[10-08,10-11) -
    //           they coexist without tripping the exclusion constraint (the
    //           write-side changeover), and coalesce to one range on read.
    await dbs.db.insert(booking).values([
      {
        tenantId: a.tenant.id,
        unitId: unitA.id,
        source: 'direct',
        status: 'confirmed',
        checkIn: '2026-08-10',
        checkOut: '2026-08-13',
        guestName: 'Top Secret Guest',
        guestPhone: '+62-secret',
      },
      {
        tenantId: a.tenant.id,
        unitId: unitA.id,
        source: 'direct',
        status: 'cancelled', // steps aside - its nights are sellable again
        checkIn: '2026-08-20',
        checkOut: '2026-08-23',
      },
      {
        tenantId: a.tenant.id,
        unitId: unitA.id,
        source: 'direct',
        status: 'confirmed',
        checkIn: '2026-10-05',
        checkOut: '2026-10-08',
      },
      {
        tenantId: a.tenant.id,
        unitId: unitA.id,
        source: 'direct',
        status: 'pending_payment', // a live hold also occupies (db-design §4.4)
        checkIn: '2026-10-08',
        checkOut: '2026-10-11',
        holdExpiresAt: new Date('2030-01-01T00:00:00Z'),
      },
    ]);

    // --- Tenant B: a booking on the same August dates, on B's own unit ----------
    const [propB] = await dbs.db
      .insert(property)
      .values({
        tenantId: b.tenant.id,
        name: 'Neighbour Villa',
        slug: testSlug(),
      })
      .returning({ id: property.id });
    const [unitB] = await dbs.db
      .insert(unit)
      .values({
        propertyId: propB.id,
        tenantId: b.tenant.id,
        name: 'B Room',
        basePriceIdr: 999_000n,
      })
      .returning({ id: unit.id });
    unitBId = unitB.id;
    await dbs.db.insert(booking).values({
      tenantId: b.tenant.id,
      unitId: unitB.id,
      source: 'direct',
      status: 'confirmed',
      checkIn: '2026-08-10',
      checkOut: '2026-08-13',
    });
  });

  afterAll(async () => {
    // Deleting the tenant cascades property -> unit and (via booking.tenant_id,
    // which is cascade) the bookings, so the no-action booking->unit FK passes
    // against zero rows (db-design §4.9). One delete cleans everything.
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  it('quotes a free window: available, priced base x nights', async () => {
    const res = await quote(unitAId, '2026-09-01', '2026-09-05');
    expect(res.status).toBe(200);
    const body = bodyOf<AvailabilityResponse>(res);
    expect(body).toMatchObject({
      available: true,
      nights: 4,
      totalPriceIdr: 14_000_000, // 3_500_000 x 4
      minStay: 2,
      reasons: [],
      blockedRanges: [],
    });
  });

  /**
   * The read-side Changeover (db-design §4.2). A confirmed stay occupies
   * [08-10,08-13); the 13th is a check-out, not a night, so a check-in on the
   * 13th is free. Half-open interval semantics, proven through HTTP.
   */
  it('frees the checkout day for the next check-in', async () => {
    const res = await quote(unitAId, '2026-08-13', '2026-08-16');
    expect(res.status).toBe(200);
    const body = bodyOf<AvailabilityResponse>(res);
    expect(body.available).toBe(true);
    expect(body.blockedRanges).toEqual([]);
    expect(body.nights).toBe(3);
    expect(body.totalPriceIdr).toBe(10_500_000);
  });

  it('clips an overlapping window to exactly the blocked nights, leaking nothing', async () => {
    const res = await quote(unitAId, '2026-08-12', '2026-08-15');
    const body = bodyOf<AvailabilityResponse>(res);
    expect(body.available).toBe(false);
    expect(body.reasons).toEqual(['overlap']);
    // booking [08-10,08-13) clipped to the queried window is [08-12,08-13).
    expect(body.blockedRanges).toEqual([
      { from: '2026-08-12', to: '2026-08-13' },
    ]);
    // No source, guest, id, or status - a blocked range is dates and nothing else.
    expect(Object.keys(body.blockedRanges[0]).sort()).toEqual(['from', 'to']);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Top Secret Guest');
    expect(serialized).not.toContain('+62-secret');
    expect(serialized).not.toMatch(/confirmed|direct/);
  });

  /**
   * Two ADJACENT occupying bookings ([10-05,10-08)+[10-08,10-11)) prove two
   * things at once: they coexist (the exclusion constraint permitted both inserts
   * - the write-side changeover), and on read they coalesce into ONE range, so a
   * Visitor never sees the seam on the 8th between the two reservations.
   */
  it('coalesces contiguous bookings into one range across a browse window', async () => {
    const res = await quote(unitAId, '2026-10-01', '2026-10-31');
    const body = bodyOf<AvailabilityResponse>(res);
    expect(body.blockedRanges).toEqual([
      { from: '2026-10-05', to: '2026-10-11' },
    ]);
  });

  it('does not block on a cancelled booking', async () => {
    const res = await quote(unitAId, '2026-08-20', '2026-08-23');
    const body = bodyOf<AvailabilityResponse>(res);
    expect(body.available).toBe(true);
    expect(body.blockedRanges).toEqual([]);
  });

  it('rejects a stay under the minimum with a min_stay reason, still priced', async () => {
    const res = await quote(unitAId, '2026-09-01', '2026-09-02'); // 1 night, minStay 2
    const body = bodyOf<AvailabilityResponse>(res);
    expect(body.available).toBe(false);
    expect(body.reasons).toEqual(['min_stay']);
    expect(body.blockedRanges).toEqual([]);
    expect(body.totalPriceIdr).toBe(3_500_000); // price is computed regardless
  });

  it('reports both reasons when a short stay also overlaps', async () => {
    const res = await quote(unitAId, '2026-08-12', '2026-08-13'); // 1 night AND overlaps
    const body = bodyOf<AvailabilityResponse>(res);
    expect(body.available).toBe(false);
    expect([...body.reasons].sort()).toEqual(['min_stay', 'overlap']);
    expect(body.blockedRanges).toEqual([
      { from: '2026-08-12', to: '2026-08-13' },
    ]);
  });

  it('quotes a zero-priced placeholder honestly at 0 (sell-gate is #48)', async () => {
    const res = await quote(unitZeroId, '2026-09-01', '2026-09-05');
    expect(res.status).toBe(200);
    const body = bodyOf<AvailabilityResponse>(res);
    expect(body.available).toBe(true);
    expect(body.totalPriceIdr).toBe(0);
  });

  it('404s an archived unit (its own flag) - indistinguishable from unknown', async () => {
    await quote(unitOwnArchivedId, '2026-09-01', '2026-09-05').expect(404);
  });

  it('404s a unit whose property is archived (derived, not stored)', async () => {
    await quote(unitUnderArchivedPropId, '2026-09-01', '2026-09-05').expect(
      404,
    );
  });

  it('404s an unknown unit id', async () => {
    await quote(randomUUID(), '2026-09-01', '2026-09-05').expect(404);
  });

  it('400s a malformed unit id before any lookup', async () => {
    await quote('not-a-uuid', '2026-09-01', '2026-09-05').expect(400);
  });

  describe('window validation (400)', () => {
    it('rejects from >= to', async () => {
      await quote(unitAId, '2026-09-05', '2026-09-01').expect(400);
      await quote(unitAId, '2026-09-01', '2026-09-01').expect(400);
    });

    it('rejects a window over 366 nights', async () => {
      await quote(unitAId, '2026-01-01', '2027-01-05').expect(400);
    });

    it('rejects a non-calendar date rather than 500ing on the no-auth route', async () => {
      await quote(unitAId, '2026-02-30', '2026-03-05').expect(400);
    });

    it('rejects a missing bound', async () => {
      await request(server())
        .get(`/api/public/units/${unitAId}/availability`)
        .query({ from: '2026-09-01' })
        .expect(400);
    });
  });

  it('exposes exactly the quote field set - nothing about the bookings', async () => {
    const res = await quote(unitAId, '2026-08-12', '2026-08-15');
    const body = bodyOf<AvailabilityResponse>(res);
    // Pinned, not spot-checked: a field must not be able to arrive here silently.
    expect(Object.keys(body).sort()).toEqual([
      'available',
      'blockedRanges',
      'minStay',
      'nights',
      'reasons',
      'totalPriceIdr',
    ]);
  });

  /**
   * Layer 2, alone (architecture §3.3). enterFromUnitId sets the GUC from unitA;
   * a booking select with NO where clause must then return only tenant A's
   * bookings - never B's, whose confirmed stay sits on the same August dates. If
   * RLS were off, the app filter would still pass this, so the query carries none.
   */
  it('RLS scopes a Visitor’s booking query to the unit’s tenant', async () => {
    const scope = app.get(PublicScope);
    const tenantDb = app.get(TenantDbService);
    const cls = app.get(ClsService);

    const rows = await cls.run(async () => {
      await scope.enterFromUnitId(unitAId);
      return tenantDb.run((tx) => tx.select().from(booking)); // no `where`
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === tenantAId())).toBe(true);
    expect(rows.map((r) => r.unitId)).not.toContain(unitBId);
  });
});
