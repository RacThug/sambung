import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { booking, tenant, unitPriceOverride } from '@sambung/db';
import {
  priceOverrideResponseSchema,
  type AuthResponse,
  type AvailabilityResponse,
  type CreateBookingResponse,
  type PriceOverrideResponse,
  type PropertyResponse,
  type UnitResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { insertCredentialFixture } from '../test-helpers';
import { PriceOverridesRepository } from './price-overrides.repository';

// The price-override lifecycle + the quote it feeds (PRD-product P0-2, EARS
// docs/spec/date-based-pricing.md), over real HTTP + DB. Staff property-scoping
// is proven at the RLS layer (packages/db/test/rls.test.ts) - here the two
// tenants stand in for "not yours = 404".
describe('Price overrides (P0-2)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const daysFromToday = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  let tokenA: string;
  let tokenB: string;
  let unitA: string;

  async function registerTenant(name: string) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: name,
        email: `po+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      })
      .expect(201);
    const body = bodyOf<AuthResponse>(res);
    createdTenantIds.push(body.tenant.id);
    return body.accessToken;
  }

  async function createUnit(token: string, basePriceIdr = 1_000_000) {
    const prop = bodyOf<PropertyResponse>(
      await request(server())
        .post('/api/properties')
        .set(auth(token))
        .send({ name: `Villa ${randomUUID().slice(0, 8)}` })
        .expect(201),
    );
    const unit = bodyOf<UnitResponse>(
      await request(server())
        .post(`/api/properties/${prop.id}/units`)
        .set(auth(token))
        .send({ name: 'Room', basePriceIdr })
        .expect(201),
    );
    return unit.id;
  }

  function createOverride(
    token: string,
    unitId: string,
    body: Record<string, unknown>,
  ) {
    return request(server())
      .post(`/api/units/${unitId}/price-overrides`)
      .set(auth(token))
      .send(body);
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

    tokenA = await registerTenant('Override Tenant A');
    tokenB = await registerTenant('Override Tenant B');
    unitA = await createUnit(tokenA);
    // The quote test books through the guest funnel, which gates on a payment
    // credential existing (REQ-PA-04, GW-03) under the real gateway binding.
    await insertCredentialFixture(dbs.db, createdTenantIds[0]);
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  describe('lifecycle (EARS OV-01/05/06)', () => {
    it('creates, lists sorted by from, and removes an override', async () => {
      const u = await createUnit(tokenA);
      // Created out of order on purpose - the list must sort by `from`.
      const later = bodyOf<PriceOverrideResponse>(
        await createOverride(tokenA, u, {
          from: '2027-12-20',
          to: '2028-01-05',
          nightlyPriceIdr: 2_500_000,
        }).expect(201),
      );
      const earlier = bodyOf<PriceOverrideResponse>(
        await createOverride(tokenA, u, {
          from: '2027-08-01',
          to: '2027-09-01',
          nightlyPriceIdr: 1_800_000,
        }).expect(201),
      );
      expect(priceOverrideResponseSchema.parse(later)).toMatchObject({
        unitId: u,
        from: '2027-12-20',
        to: '2028-01-05',
        nightlyPriceIdr: 2_500_000,
      });

      const listed = bodyOf<PriceOverrideResponse[]>(
        await request(server())
          .get(`/api/units/${u}/price-overrides`)
          .set(auth(tokenA))
          .expect(200),
      );
      expect(listed.map((o) => o.id)).toEqual([earlier.id, later.id]);

      await request(server())
        .delete(`/api/price-overrides/${earlier.id}`)
        .set(auth(tokenA))
        .expect(204);
      // A repeat delete is a 404: already gone = gone (the caller's retry is
      // harmless, but the API never claims to have deleted twice).
      await request(server())
        .delete(`/api/price-overrides/${earlier.id}`)
        .set(auth(tokenA))
        .expect(404);
    });

    it('allows back-to-back seasons - half-open ranges sharing a boundary (OV-03)', async () => {
      const u = await createUnit(tokenA);
      await createOverride(tokenA, u, {
        from: '2027-06-01',
        to: '2027-07-01',
        nightlyPriceIdr: 1_500_000,
      }).expect(201);
      await createOverride(tokenA, u, {
        from: '2027-07-01',
        to: '2027-08-01',
        nightlyPriceIdr: 2_000_000,
      }).expect(201);
    });

    it('rejects an unknown key, an inverted range, and a zero price as 400s (OV-04)', async () => {
      await createOverride(tokenA, unitA, {
        from: '2027-06-01',
        to: '2027-07-01',
        nightlyPriceIdr: 1_500_000,
        nightlyPricIdr: 9, // typo'd key must be a loud 400, not silently dropped
      }).expect(400);
      await createOverride(tokenA, unitA, {
        from: '2027-07-01',
        to: '2027-06-01',
        nightlyPriceIdr: 1_500_000,
      }).expect(400);
      await createOverride(tokenA, unitA, {
        from: '2027-06-01',
        to: '2027-07-01',
        nightlyPriceIdr: 0,
      }).expect(400);
    });

    it('does not gate on archived - pricing a retired unit is allowed (OV-07)', async () => {
      const u = await createUnit(tokenA);
      await request(server())
        .post(`/api/units/${u}/archive`)
        .set(auth(tokenA))
        .expect(200);
      await createOverride(tokenA, u, {
        from: '2027-06-01',
        to: '2027-07-01',
        nightlyPriceIdr: 1_500_000,
      }).expect(201);
    });
  });

  describe('the overlap 409 (EARS OV-02, §5.3 both layers)', () => {
    it('pre-check and forced-constraint paths return byte-identical bodies', async () => {
      const u = await createUnit(tokenA);
      await createOverride(tokenA, u, {
        from: '2027-07-01',
        to: '2027-08-01',
        nightlyPriceIdr: 1_500_000,
      }).expect(201);

      // Layer 1: the app pre-check answers.
      const preCheck = await createOverride(tokenA, u, {
        from: '2027-07-15',
        to: '2027-09-01',
        nightlyPriceIdr: 2_000_000,
      }).expect(409);
      expect(preCheck.body).toMatchObject({ code: 'price_override_overlap' });

      // Layer 2: blind the pre-check so the INSERT reaches the exclusion
      // constraint - the deterministic constraint-force (#48's pattern). The
      // interceptor must map `price_override_no_overlap` to the SAME body.
      const repo = app.get(PriceOverridesRepository);
      const spy = jest
        .spyOn(repo, 'overlapExists')
        .mockResolvedValueOnce(false);
      try {
        const constraint = await createOverride(tokenA, u, {
          from: '2027-07-15',
          to: '2027-09-01',
          nightlyPriceIdr: 2_000_000,
        }).expect(409);
        expect(constraint.body).toEqual(preCheck.body);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('isolation (EARS ISO-01)', () => {
    it('another tenant reads 404, writes 404, deletes 404 - and the row survives', async () => {
      const u = await createUnit(tokenA);
      const mine = bodyOf<PriceOverrideResponse>(
        await createOverride(tokenA, u, {
          from: '2027-07-01',
          to: '2027-08-01',
          nightlyPriceIdr: 1_500_000,
        }).expect(201),
      );

      await request(server())
        .get(`/api/units/${u}/price-overrides`)
        .set(auth(tokenB))
        .expect(404);
      await createOverride(tokenB, u, {
        from: '2027-09-01',
        to: '2027-10-01',
        nightlyPriceIdr: 1_000_000,
      }).expect(404);
      await request(server())
        .delete(`/api/price-overrides/${mine.id}`)
        .set(auth(tokenB))
        .expect(404);

      const rows = await dbs.db
        .select({ id: unitPriceOverride.id })
        .from(unitPriceOverride)
        .where(eq(unitPriceOverride.id, mine.id));
      expect(rows).toHaveLength(1);
    });

    it('an unknown unit id is a 404 on list and create', async () => {
      const ghost = randomUUID();
      await request(server())
        .get(`/api/units/${ghost}/price-overrides`)
        .set(auth(tokenA))
        .expect(404);
      await createOverride(tokenA, ghost, {
        from: '2027-07-01',
        to: '2027-08-01',
        nightlyPriceIdr: 1_500_000,
      }).expect(404);
    });
  });

  describe('the quote prices through overrides (EARS PR-01/02/03/04)', () => {
    it('quotes override nights at the override, snapshots the booking, and never re-prices it', async () => {
      // Base 1m; nights [d+10, d+14); override 2.5m covers [d+12, d+14)
      // -> 2 base nights + 2 override nights = 7m.
      const u = await createUnit(tokenA, 1_000_000);
      const from = daysFromToday(10);
      const to = daysFromToday(14);
      await createOverride(tokenA, u, {
        from: daysFromToday(12),
        to: daysFromToday(14),
        nightlyPriceIdr: 2_500_000,
      }).expect(201);

      // The public read (PR-03: same quote authority, no auth).
      const quote = bodyOf<AvailabilityResponse>(
        await request(server())
          .get(`/api/public/units/${u}/availability`)
          .query({ from, to })
          .expect(200),
      );
      expect(quote.totalPriceIdr).toBe(7_000_000);

      // The write prices identically (PR-03: one authority, in-transaction).
      const created = bodyOf<CreateBookingResponse>(
        await request(server())
          .post('/api/public/bookings')
          .send({
            unitId: u,
            checkIn: from,
            checkOut: to,
            guestName: 'Putu Override',
            guestPhone: '+6281234567890',
            guestCount: 2,
          })
          .expect(201),
      );
      expect(created.totalPriceIdr).toBe(7_000_000);

      // PR-04: the snapshot survives the override's deletion untouched.
      const [override] = await dbs.db
        .select({ id: unitPriceOverride.id })
        .from(unitPriceOverride)
        .where(eq(unitPriceOverride.unitId, u));
      await request(server())
        .delete(`/api/price-overrides/${override.id}`)
        .set(auth(tokenA))
        .expect(204);
      const [row] = await dbs.db
        .select({ totalPriceIdr: booking.totalPriceIdr })
        .from(booking)
        .where(eq(booking.id, created.bookingId));
      expect(row.totalPriceIdr).toBe(7_000_000n);
    });

    it('an owner walk-in with no negotiated price lands at the override total (PR-03)', async () => {
      // Base 1m; override 2.5m covers the whole 2-night stay -> 5m. The owner
      // omits totalPriceIdr, so the server's quote - the SAME authority the
      // funnel uses - fills it, overrides included.
      const u = await createUnit(tokenA, 1_000_000);
      await createOverride(tokenA, u, {
        from: daysFromToday(20),
        to: daysFromToday(22),
        nightlyPriceIdr: 2_500_000,
      }).expect(201);

      const walkIn = bodyOf<{ totalPriceIdr: number | null }>(
        await request(server())
          .post('/api/bookings')
          .set(auth(tokenA))
          .send({
            source: 'direct',
            unitId: u,
            checkIn: daysFromToday(20),
            checkOut: daysFromToday(22),
            guestName: 'Ketut Walk-in',
          })
          .expect(201),
      );
      expect(walkIn.totalPriceIdr).toBe(5_000_000);
    });

    it('a stay clear of every override still prices at base x nights', async () => {
      const u = await createUnit(tokenA, 1_000_000);
      await createOverride(tokenA, u, {
        from: daysFromToday(50),
        to: daysFromToday(60),
        nightlyPriceIdr: 2_500_000,
      }).expect(201);
      const quote = bodyOf<AvailabilityResponse>(
        await request(server())
          .get(`/api/public/units/${u}/availability`)
          .query({ from: daysFromToday(10), to: daysFromToday(13) })
          .expect(200),
      );
      expect(quote.totalPriceIdr).toBe(3_000_000);
    });
  });
});
