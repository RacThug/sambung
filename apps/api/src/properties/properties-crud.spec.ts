import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { booking, property, tenant, unit } from '@sambung/db';
import {
  propertyResponseSchema,
  type AuthResponse,
  type PropertyResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { TenantDbService } from '../db/tenant-db.service';
import { PropertiesService } from './properties.service';
import { PropertiesRepository } from './properties.repository';

// Property CRUD (FR-PROP-1/3, api-spec §4.3-4.4) over real HTTP + DB.
describe('Property CRUD', () => {
  let app: INestApplication;
  let dbs: DbService;
  let cls: ClsService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  // 'YYYY-MM-DD' offset from today. ±30 days keeps every assertion far from
  // any midnight/timezone boundary between this process and the DB server.
  const daysFromToday = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  async function registerTenant(name: string) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: name,
        email: `crud+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    const auth = bodyOf<AuthResponse>(res);
    createdTenantIds.push(auth.tenant.id);
    return auth;
  }

  async function createProperty(
    token: string,
    body: Record<string, unknown> = { name: 'CRUD Villa' },
  ): Promise<PropertyResponse> {
    const res = await request(server())
      .post('/api/properties')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    return bodyOf<PropertyResponse>(res);
  }

  // Inventory/booking fixtures go straight through the owner-role connection:
  // unit CRUD is #45 and booking creation is M2, so no API exists for them yet.
  async function seedUnit(tenantId: string, propertyId: string, price: bigint) {
    const [row] = await dbs.db
      .insert(unit)
      .values({ tenantId, propertyId, name: 'Room', basePriceIdr: price })
      .returning({ id: unit.id });
    return row.id;
  }

  async function seedBooking(
    tenantId: string,
    unitId: string,
    status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired',
    checkIn: string,
    checkOut: string,
  ) {
    await dbs.db.insert(booking).values({
      tenantId,
      unitId,
      source: 'direct',
      status,
      checkIn,
      checkOut,
      guestName: 'Test guest',
    });
  }

  let tokenA: string;
  let tenantAId: string;
  let tokenB: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);
    cls = app.get(ClsService);

    const a = await registerTenant('CRUD Tenant A');
    const b = await registerTenant('CRUD Tenant B');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    tokenB = b.accessToken;
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  describe('POST /api/properties', () => {
    it('creates a property scoped to the caller tenant (201)', async () => {
      const created = await createProperty(tokenA, {
        name: 'Sunset Villa',
        address: 'Jl. Test 1, Seminyak',
        latitude: -8.69,
        longitude: 115.16,
        description: 'A test villa.',
      });
      expect(created).toMatchObject({
        name: 'Sunset Villa',
        address: 'Jl. Test 1, Seminyak',
        tenantId: tenantAId,
        verified: false,
        publishable: false,
        licenseNo: null,
      });
      // Contract conformance: the response parses against the shared schema.
      expect(() => propertyResponseSchema.parse(created)).not.toThrow();

      const [row] = await dbs.db
        .select()
        .from(property)
        .where(eq(property.id, created.id));
      expect(row.tenantId).toBe(tenantAId);
    });

    it('derives verified=true when licenseNo is present (FR-PROP-3)', async () => {
      const created = await createProperty(tokenA, {
        name: 'Licensed Villa',
        licenseNo: 'NIB-1234567890',
      });
      expect(created.verified).toBe(true);
      expect(created.licenseNo).toBe('NIB-1234567890');
    });

    it('rejects a missing name with a field-mapped 400', async () => {
      const res = await request(server())
        .post('/api/properties')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ address: 'nameless' })
        .expect(400);
      const message = bodyOf<{ message: Array<{ path: string }> }>(res).message;
      expect(message.some((i) => i.path === 'name')).toBe(true);
    });

    it('rejects an out-of-range latitude (400)', async () => {
      await request(server())
        .post('/api/properties')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Bad Geo Villa', latitude: 91 })
        .expect(400);
    });

    it('rejects unauthenticated create (401)', async () => {
      await request(server())
        .post('/api/properties')
        .send({ name: 'Anon Villa' })
        .expect(401);
    });
  });

  describe('PATCH /api/properties/:id', () => {
    it('updates fields and re-derives verified across set/clear', async () => {
      const created = await createProperty(tokenA, { name: 'Patch Villa' });

      const set = await request(server())
        .patch(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Patched Villa', licenseNo: 'NIB-42' })
        .expect(200);
      expect(bodyOf<PropertyResponse>(set)).toMatchObject({
        name: 'Patched Villa',
        licenseNo: 'NIB-42',
        verified: true,
      });

      const cleared = await request(server())
        .patch(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ licenseNo: null })
        .expect(200);
      expect(bodyOf<PropertyResponse>(cleared)).toMatchObject({
        licenseNo: null,
        verified: false,
      });
    });

    it('normalizes a blank licenseNo to null - no gaming the badge', async () => {
      const created = await createProperty(tokenA, {
        name: 'Blank License Villa',
      });
      const res = await request(server())
        .patch(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ licenseNo: '   ' })
        .expect(200);
      expect(bodyOf<PropertyResponse>(res)).toMatchObject({
        licenseNo: null,
        verified: false,
      });
    });

    it('accepts an empty patch as a no-op (200)', async () => {
      const created = await createProperty(tokenA, { name: 'Noop Villa' });
      const res = await request(server())
        .patch(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(200);
      expect(bodyOf<PropertyResponse>(res).name).toBe('Noop Villa');
    });

    it('rejects a null name (400)', async () => {
      const created = await createProperty(tokenA, { name: 'Null Name Villa' });
      await request(server())
        .patch(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: null })
        .expect(400);
    });

    it('rejects a malformed UUID before any lookup (400)', async () => {
      await request(server())
        .patch('/api/properties/not-a-uuid')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Whatever Villa' })
        .expect(400);
    });

    it("404s another tenant's property and leaves it unchanged", async () => {
      const theirs = await createProperty(tokenB, { name: 'B Patch Villa' });
      await request(server())
        .patch(`/api/properties/${theirs.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Hijacked Villa' })
        .expect(404);

      const [row] = await dbs.db
        .select()
        .from(property)
        .where(eq(property.id, theirs.id));
      expect(row.name).toBe('B Patch Villa');
    });
  });

  describe('DELETE /api/properties/:id', () => {
    it('deletes a property without bookings (204) and cascades its units', async () => {
      const created = await createProperty(tokenA, { name: 'Doomed Villa' });
      const unitId = await seedUnit(tenantAId, created.id, 1_000_000n);

      await request(server())
        .delete(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      await request(server())
        .get(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
      const units = await dbs.db.select().from(unit).where(eq(unit.id, unitId));
      expect(units).toHaveLength(0);
    });

    it('409s when future occupying bookings exist, naming the count', async () => {
      const created = await createProperty(tokenA, { name: 'Booked Villa' });
      const unitId = await seedUnit(tenantAId, created.id, 2_000_000n);
      // One future confirmed + one in-house hold (checked in, not out) -
      // both occupy [checkIn, checkOut) beyond today, so both must count.
      await seedBooking(
        tenantAId,
        unitId,
        'confirmed',
        daysFromToday(30),
        daysFromToday(33),
      );
      await seedBooking(
        tenantAId,
        unitId,
        'pending_payment',
        daysFromToday(-30),
        daysFromToday(30),
      );

      const res = await request(server())
        .delete(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(409);
      expect(bodyOf<{ message: string }>(res).message).toContain('2');

      // Still alive.
      await request(server())
        .get(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
    });

    it('ignores past, cancelled and expired bookings (204)', async () => {
      const created = await createProperty(tokenA, { name: 'History Villa' });
      const unitId = await seedUnit(tenantAId, created.id, 500_000n);
      await seedBooking(
        tenantAId,
        unitId,
        'confirmed',
        daysFromToday(-40),
        daysFromToday(-30),
      );
      await seedBooking(
        tenantAId,
        unitId,
        'cancelled',
        daysFromToday(30),
        daysFromToday(33),
      );
      await seedBooking(
        tenantAId,
        unitId,
        'expired',
        daysFromToday(40),
        daysFromToday(43),
      );

      await request(server())
        .delete(`/api/properties/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);
    });

    it("404s another tenant's property and leaves it standing", async () => {
      const theirs = await createProperty(tokenB, { name: 'B Delete Villa' });
      await request(server())
        .delete(`/api/properties/${theirs.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);

      const rows = await dbs.db
        .select()
        .from(property)
        .where(eq(property.id, theirs.id));
      expect(rows).toHaveLength(1);
    });

    it('rejects unauthenticated delete (401)', async () => {
      await request(server())
        .delete(`/api/properties/${randomUUID()}`)
        .expect(401);
    });
  });

  describe('derived flags on reads', () => {
    it('GET list rows carry verified/publishable', async () => {
      const res = await request(server())
        .get('/api/properties')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const rows = bodyOf<PropertyResponse[]>(res);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(typeof row.verified).toBe('boolean');
        expect(typeof row.publishable).toBe('boolean');
      }
    });

    // publishable can't reach true until photo storage lands (#39), so pin the
    // unit half of the rule at the repository seam: only price > 0 counts.
    it('repository counts only units priced above zero', async () => {
      const created = await createProperty(tokenA, { name: 'Count Villa' });
      await seedUnit(tenantAId, created.id, 0n);
      await seedUnit(tenantAId, created.id, 750_000n);

      const repo = app.get(PropertiesRepository);
      const row = await cls.run(async () => {
        cls.set('principal', {
          userId: 'test',
          tenantId: tenantAId,
          role: 'owner',
        });
        return repo.findByIdForTenant(created.id, tenantAId);
      });
      expect(row?.pricedUnitCount).toBe(1);
    });
  });

  // The delete guard (api-spec §4.4) is only sound if its lock, count and
  // delete share ONE transaction: a lock released before the count guards
  // nothing, and the HTTP tests above pass either way. These pin the unit of
  // work itself. The spies below call through - they instrument, they don't
  // fake, so the "fakes only at the outbound provider edge" rule holds.
  describe('DELETE /api/properties/:id — the guard is one unit of work', () => {
    const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
      cls.run(() => {
        cls.set('principal', {
          userId: 'test',
          tenantId: tenantAId,
          role: 'owner',
        });
        return fn();
      });

    afterEach(() => jest.restoreAllMocks());

    it('takes the lock, counts and deletes in one transaction, lock first', async () => {
      const created = await createProperty(tokenA, { name: 'Unit Of Work' });
      const repo = app.get(PropertiesRepository);
      const tenantDb = app.get(TenantDbService);

      const calls: string[] = [];
      const xids: string[] = [];
      // Joins the ambient transaction if there is one, opens its own if not -
      // so three identical ids prove one transaction, and differing ids prove
      // the guard has come apart.
      const record = async (name: string) => {
        calls.push(name);
        xids.push(
          await tenantDb.run(async (tx) => {
            const r = await tx.execute(sql`select pg_current_xact_id() as id`);
            return String((r.rows[0] as { id: string | number }).id);
          }),
        );
      };

      // A second real repository over the same TenantDbService singleton, so
      // the pass-through joins the ambient transaction exactly as the original
      // would. (`.bind` would do, but apps/api sets strictBindCallApply:false,
      // which degrades it to `any`.)
      const real = new PropertiesRepository(tenantDb);

      jest.spyOn(repo, 'lockForDelete').mockImplementation(async (id, t) => {
        await record('lockForDelete');
        return real.lockForDelete(id, t);
      });
      jest
        .spyOn(repo, 'countFutureOccupying')
        .mockImplementation(async (id) => {
          await record('countFutureOccupying');
          return real.countFutureOccupying(id);
        });
      jest.spyOn(repo, 'delete').mockImplementation(async (id, t) => {
        await record('delete');
        return real.delete(id, t);
      });

      await asOwner(() => app.get(PropertiesService).remove(created.id));

      // Order: the lock must precede the count, or the count is a TOCTOU read.
      expect(calls).toEqual([
        'lockForDelete',
        'countFutureOccupying',
        'delete',
      ]);
      // Identity: all three in the same transaction, so the lock still holds.
      expect(new Set(xids).size).toBe(1);
    });

    it('refuses to take the lock outside a unit of work', async () => {
      const created = await createProperty(tokenA, { name: 'Lock Guard' });
      const repo = app.get(PropertiesRepository);

      await expect(
        asOwner(() => repo.lockForDelete(created.id, tenantAId)),
      ).rejects.toThrow(/must be called inside TenantDbService\.run/);
    });
  });
});
