import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { booking, payment, tenant, unit } from '@sambung/db';
import {
  unitResponseSchema,
  type AuthResponse,
  type PropertyResponse,
  type UnitResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';
import { UnitsRepository } from './units.repository';
import { UnitsService } from './units.service';

// Unit CRUD (FR-PROP-2, api-spec §4.6) over real HTTP + DB.
describe('Unit CRUD', () => {
  let app: INestApplication;
  let dbs: DbService;
  let cls: ClsService;
  let tenantCtx: TenantContext;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  const daysFromToday = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  let tokenA: string;
  let tenantAId: string;
  let propertyId: string;

  async function createProperty(token: string, name: string) {
    const res = await request(server())
      .post('/api/properties')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);
    return bodyOf<PropertyResponse>(res);
  }

  async function createUnit(
    body: Record<string, unknown>,
    propId = propertyId,
  ) {
    const res = await request(server())
      .post(`/api/properties/${propId}/units`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send(body)
      .expect(201);
    return bodyOf<UnitResponse>(res);
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
    cls = app.get(ClsService);
    tenantCtx = app.get(TenantContext);

    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: 'Unit CRUD Tenant',
        email: `unit-crud+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    const auth = bodyOf<AuthResponse>(res);
    createdTenantIds.push(auth.tenant.id);
    tokenA = auth.accessToken;
    tenantAId = auth.tenant.id;
    propertyId = (await createProperty(tokenA, 'CRUD Villa')).id;
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  describe('POST /api/properties/:id/units', () => {
    // The issue's headline AC, end to end.
    it('adds "Garden Room, 1200000 IDR, min-stay 1" and lists it under the property', async () => {
      const created = await createUnit({
        name: 'Garden Room',
        basePriceIdr: 1_200_000,
        minStay: 1,
      });
      expect(unitResponseSchema.parse(created)).toMatchObject({
        name: 'Garden Room',
        basePriceIdr: 1_200_000,
        minStay: 1,
        maxGuests: 2, // spec'd default
        propertyId,
        tenantId: tenantAId,
      });

      const res = await request(server())
        .get(`/api/properties/${propertyId}/units`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<UnitResponse[]>(res).map((u) => u.name)).toContain(
        'Garden Room',
      );
    });

    // Money crosses the wire as a JSON number (api-spec §1). The column is a
    // bigint and Drizzle hands back a BigInt, which JSON.stringify throws on -
    // so this asserts the serialization helper is actually in the path, not that
    // arithmetic works.
    it('returns the price as a JSON number, not a string or a crash', async () => {
      const created = await createUnit({
        name: 'Money Room',
        basePriceIdr: 1_500_000,
      });
      expect(created.basePriceIdr).toBe(1_500_000);
      expect(typeof created.basePriceIdr).toBe('number');
    });

    it('stores a zero price but leaves the property unpublishable', async () => {
      const prop = await createProperty(tokenA, 'Placeholder Villa');
      const created = await createUnit(
        { name: 'Unpriced Room', basePriceIdr: 0 },
        prop.id,
      );
      expect(created.basePriceIdr).toBe(0);

      const res = await request(server())
        .get(`/api/properties/${prop.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<PropertyResponse>(res).publishable).toBe(false);
    });

    // Layer 1 of "rejected twice over". Layer 2 (the CHECK, with zod bypassed)
    // is packages/db/test/unit-bounds.test.ts - and it has to be a separate
    // test, because if zod works this request never reaches the CHECK.
    it('400s a negative price, naming the field', async () => {
      const res = await request(server())
        .post(`/api/properties/${propertyId}/units`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Cheap Room', basePriceIdr: -1 })
        .expect(400);
      expect(
        bodyOf<{ message: Array<{ path: string }> }>(res).message,
      ).toContainEqual(expect.objectContaining({ path: 'basePriceIdr' }));
    });

    it('400s a fractional price, maxGuests of 0 and minStay of 0', async () => {
      for (const body of [
        { name: 'A', basePriceIdr: 1000.5 },
        { name: 'B', basePriceIdr: 1000, maxGuests: 0 },
        { name: 'C', basePriceIdr: 1000, minStay: 0 },
      ]) {
        await request(server())
          .post(`/api/properties/${propertyId}/units`)
          .set('Authorization', `Bearer ${tokenA}`)
          .send(body)
          .expect(400);
      }
    });

    // ADR-0001: 8 identical rooms are 8 rows, so the name is the only thing
    // telling them apart - and M4 wires OTA feeds from a dropdown labelled by it.
    it('409s a duplicate name within one property', async () => {
      const prop = await createProperty(tokenA, 'Dup Villa');
      await createUnit(
        { name: 'Garden Room', basePriceIdr: 1_000_000 },
        prop.id,
      );
      const res = await request(server())
        .post(`/api/properties/${prop.id}/units`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Garden Room', basePriceIdr: 1_000_000 })
        .expect(409);
      expect(bodyOf<{ message: string }>(res).message).toMatch(
        /already exists/i,
      );
    });

    it('allows the same name under a different property', async () => {
      const other = await createProperty(tokenA, 'Other Villa');
      await expect(
        createUnit({ name: 'Garden Room', basePriceIdr: 1_000_000 }, other.id),
      ).resolves.toMatchObject({ name: 'Garden Room' });
    });

    it('400s a malformed property uuid before any lookup', async () => {
      await request(server())
        .post('/api/properties/not-a-uuid/units')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'X', basePriceIdr: 1 })
        .expect(400);
    });
  });

  describe('PATCH /api/units/:id', () => {
    it('updates a single field and leaves the rest alone', async () => {
      const created = await createUnit({
        name: 'Patch Room',
        basePriceIdr: 900_000,
        maxGuests: 4,
        minStay: 3,
      });
      const res = await request(server())
        .patch(`/api/units/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ basePriceIdr: 1_100_000 })
        .expect(200);

      // The trap this guards: create's schema carries .default(2)/.default(1),
      // so if .partial() let those fire, an absent maxGuests would silently
      // reset 4 -> 2.
      expect(bodyOf<UnitResponse>(res)).toMatchObject({
        basePriceIdr: 1_100_000,
        maxGuests: 4,
        minStay: 3,
        name: 'Patch Room',
      });
    });

    it('accepts an empty patch as a no-op', async () => {
      const created = await createUnit({
        name: 'Noop Room',
        basePriceIdr: 800_000,
      });
      const res = await request(server())
        .patch(`/api/units/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(200);
      expect(bodyOf<UnitResponse>(res).basePriceIdr).toBe(800_000);
    });

    it('404s an unknown unit id', async () => {
      await request(server())
        .patch(`/api/units/${randomUUID()}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Ghost' })
        .expect(404);
    });

    it('409s a rename onto a sibling’s name', async () => {
      const prop = await createProperty(tokenA, 'Rename Villa');
      await createUnit({ name: 'Room One', basePriceIdr: 1 }, prop.id);
      const two = await createUnit(
        { name: 'Room Two', basePriceIdr: 1 },
        prop.id,
      );
      await request(server())
        .patch(`/api/units/${two.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Room One' })
        .expect(409);
    });
  });

  describe('DELETE /api/units/:id', () => {
    it('deletes a never-booked unit (204)', async () => {
      const created = await createUnit({
        name: 'Doomed Room',
        basePriceIdr: 500_000,
      });
      await request(server())
        .delete(`/api/units/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);
      const rows = await dbs.db
        .select()
        .from(unit)
        .where(eq(unit.id, created.id));
      expect(rows).toHaveLength(0);
    });

    // ADR-0002. The old property rule counted only FUTURE OCCUPYING bookings, so
    // this stay - ended six weeks ago, cancelled, paid for - was invisible to it
    // and the delete ate it along with its payment row.
    it('409s on a past cancelled booking and leaves the ledger intact', async () => {
      const created = await createUnit({
        name: 'Historic Room',
        basePriceIdr: 500_000,
      });
      const [b] = await dbs.db
        .insert(booking)
        .values({
          tenantId: tenantAId,
          unitId: created.id,
          source: 'direct',
          status: 'cancelled',
          checkIn: daysFromToday(-40),
          checkOut: daysFromToday(-38),
          guestName: 'Long gone',
        })
        .returning({ id: booking.id });
      await dbs.db.insert(payment).values({
        bookingId: b.id,
        provider: 'midtrans',
        amountIdr: 1_000_000n,
      });

      const res = await request(server())
        .delete(`/api/units/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(409);
      const { message } = bodyOf<{ message: string }>(res);
      expect(message).toContain('1 booking');
      // No "cancel them first" - it's already cancelled, and cancelling never
      // removes the row. The message must not promise an escape that isn't there.
      expect(message).not.toContain('cancel');

      expect(
        await dbs.db.select().from(payment).where(eq(payment.bookingId, b.id)),
      ).toHaveLength(1);
      expect(
        await dbs.db.select().from(unit).where(eq(unit.id, created.id)),
      ).toHaveLength(1);
    });

    it('409s on a future confirmed booking too', async () => {
      const created = await createUnit({
        name: 'Busy Room',
        basePriceIdr: 500_000,
      });
      await dbs.db.insert(booking).values({
        tenantId: tenantAId,
        unitId: created.id,
        source: 'direct',
        status: 'confirmed',
        checkIn: daysFromToday(30),
        checkOut: daysFromToday(33),
        guestName: 'Incoming',
      });
      await request(server())
        .delete(`/api/units/${created.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(409);
    });

    it('404s an unknown unit id', async () => {
      await request(server())
        .delete(`/api/units/${randomUUID()}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });
  });

  // The guard is only sound if its lock, count and delete share ONE
  // transaction: a lock released before the count guards nothing, and every
  // HTTP test above passes either way. These pin the unit of work itself.
  // (Twin of the same block in properties-crud.spec.ts.) The spies call
  // through - they instrument, they don't fake.
  describe('DELETE /api/units/:id — the guard is one unit of work', () => {
    afterEach(() => jest.restoreAllMocks());

    /** Run fn as tenant A's owner, the way a request would. */
    const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
      cls.run(() => {
        tenantCtx.set({ userId: 'test', tenantId: tenantAId, role: 'owner' });
        return fn();
      });

    it('takes the lock, counts and deletes in one transaction, lock first', async () => {
      const created = await createUnit({
        name: 'Unit Of Work',
        basePriceIdr: 500_000,
      });
      const repo = app.get(UnitsRepository);
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
      // would.
      const real = new UnitsRepository(tenantDb, tenantCtx);

      jest.spyOn(repo, 'lockForDelete').mockImplementation(async (id) => {
        await record('lockForDelete');
        return real.lockForDelete(id);
      });
      jest.spyOn(repo, 'countBookings').mockImplementation(async (id) => {
        await record('countBookings');
        return real.countBookings(id);
      });
      jest.spyOn(repo, 'delete').mockImplementation(async (id) => {
        await record('delete');
        return real.delete(id);
      });

      await asOwner(() => app.get(UnitsService).remove(created.id));

      // Order: the lock must precede the count, or the count is a TOCTOU read.
      expect(calls).toEqual(['lockForDelete', 'countBookings', 'delete']);
      // Identity: all three in the same transaction, so the lock still holds.
      expect(new Set(xids).size).toBe(1);
    });

    it('refuses to take the lock outside a unit of work', async () => {
      const created = await createUnit({
        name: 'Lock Guard',
        basePriceIdr: 500_000,
      });
      const repo = app.get(UnitsRepository);

      await expect(
        asOwner(() => repo.lockForDelete(created.id)),
      ).rejects.toThrow(/must be called inside TenantDbService\.run/);
    });
  });
});
