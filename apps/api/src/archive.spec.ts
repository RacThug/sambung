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
  PropertyResponse,
  PublicPropertyResponse,
  UnitResponse,
} from '@sambung/shared';
import { AppModule } from './app.module';
import { DbService } from './db/db.service';
import { testSlug } from './test-helpers';

/**
 * Archive: retire inventory that has history (ADR-0005 / ADR-0006, #84).
 *
 * The story spans units, properties AND the public page, so it lives in one
 * cross-cutting spec rather than being scattered across three. What matters here
 * is not "does the flag flip" but the derived behaviour: archiving a Property
 * hides its Units without a cascade write, unarchive restores exactly the right
 * set, the public page 404s a retired Property, and the ledger is never touched.
 */
describe('Archive (retire inventory with history) - #84', () => {
  let app: INestApplication;
  let dbs: DbService;
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
  let tenantBId: string;

  async function registerTenant(name: string) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: name,
        email: `archive+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    const auth = bodyOf<AuthResponse>(res);
    createdTenantIds.push(auth.tenant.id);
    return auth;
  }

  const createProperty = async (name: string): Promise<PropertyResponse> =>
    bodyOf<PropertyResponse>(
      await request(server())
        .post('/api/properties')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name })
        .expect(201),
    );

  const addUnit = async (
    propertyId: string,
    name: string,
    basePriceIdr = 1_000_000,
  ): Promise<UnitResponse> =>
    bodyOf<UnitResponse>(
      await request(server())
        .post(`/api/properties/${propertyId}/units`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name, basePriceIdr })
        .expect(201),
    );

  const getProperty = async (id: string): Promise<PropertyResponse> =>
    bodyOf<PropertyResponse>(
      await request(server())
        .get(`/api/properties/${id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200),
    );

  const listUnits = async (propertyId: string): Promise<UnitResponse[]> =>
    bodyOf<UnitResponse[]>(
      await request(server())
        .get(`/api/properties/${propertyId}/units`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200),
    );

  const getPublic = (slug: string) =>
    request(server()).get(`/api/public/properties/${slug}`);

  // A property with photos (so publishability can reach true) inserted straight
  // through the owner connection - the presign/upload dance (#39) is irrelevant
  // to archive, and this keeps the fixtures about retirement.
  let seq = 0;
  async function seedProperty(
    tenantId: string,
    opts: { photos?: string[] } = {},
  ) {
    const slug = testSlug();
    const [row] = await dbs.db
      .insert(property)
      .values({
        tenantId,
        name: `Villa ${++seq}`,
        slug,
        photos: opts.photos ?? [],
      })
      .returning({ id: property.id });
    return { id: row.id, slug };
  }

  async function seedUnit(
    tenantId: string,
    propertyId: string,
    price: bigint,
  ): Promise<string> {
    const [row] = await dbs.db
      .insert(unit)
      .values({
        tenantId,
        propertyId,
        name: `Room ${++seq}`,
        basePriceIdr: price,
      })
      .returning({ id: unit.id });
    return row.id;
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

    const a = await registerTenant('Archive Tenant A');
    const b = await registerTenant('Archive Tenant B');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  describe('POST /api/units/:id/archive|unarchive', () => {
    it('archives a unit (200), sets archivedAt, and the owner still sees it', async () => {
      const prop = await createProperty('Unit Archive Villa');
      const u = await addUnit(prop.id, 'Garden Room');
      expect(u.archivedAt).toBeNull();

      const res = await request(server())
        .post(`/api/units/${u.id}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<UnitResponse>(res).archivedAt).not.toBeNull();

      // Owner still sees it - archive is intra-tenant visibility, not deletion.
      const listed = await listUnits(prop.id);
      expect(listed.map((x) => x.id)).toContain(u.id);
      expect(listed.find((x) => x.id === u.id)?.archivedAt).not.toBeNull();
    });

    it('unarchives a unit, clearing archivedAt', async () => {
      const prop = await createProperty('Unit Unarchive Villa');
      const u = await addUnit(prop.id, 'Garden Room');
      await request(server())
        .post(`/api/units/${u.id}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const res = await request(server())
        .post(`/api/units/${u.id}/unarchive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<UnitResponse>(res).archivedAt).toBeNull();
    });

    it('is idempotent: re-archiving keeps the original archivedAt', async () => {
      const prop = await createProperty('Idempotent Villa');
      const u = await addUnit(prop.id, 'Garden Room');
      const first = bodyOf<UnitResponse>(
        await request(server())
          .post(`/api/units/${u.id}/archive`)
          .set('Authorization', `Bearer ${tokenA}`)
          .expect(200),
      ).archivedAt;
      const second = bodyOf<UnitResponse>(
        await request(server())
          .post(`/api/units/${u.id}/archive`)
          .set('Authorization', `Bearer ${tokenA}`)
          .expect(200),
      ).archivedAt;
      expect(second).toBe(first); // the "retired on" date must not reset
    });

    it('treats unarchiving an active unit as a no-op (200, not 409)', async () => {
      const prop = await createProperty('Noop Villa');
      const u = await addUnit(prop.id, 'Garden Room');
      const res = await request(server())
        .post(`/api/units/${u.id}/unarchive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<UnitResponse>(res).archivedAt).toBeNull();
    });

    it('404s an unknown unit id', async () => {
      await request(server())
        .post(`/api/units/${randomUUID()}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    // The point of the whole feature: honour what's sold, stop selling more.
    it('never touches existing bookings or their payment rows', async () => {
      const { id: propId } = await seedProperty(tenantAId);
      const unitId = await seedUnit(tenantAId, propId, 1_000_000n);
      const [b] = await dbs.db
        .insert(booking)
        .values({
          tenantId: tenantAId,
          unitId,
          source: 'direct',
          status: 'confirmed',
          checkIn: daysFromToday(30),
          checkOut: daysFromToday(33),
          guestName: 'Incoming guest',
        })
        .returning({ id: booking.id });
      await dbs.db.insert(payment).values({
        bookingId: b.id,
        provider: 'midtrans',
        amountIdr: 2_000_000n,
      });

      await request(server())
        .post(`/api/units/${unitId}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(
        await dbs.db.select().from(booking).where(eq(booking.id, b.id)),
      ).toHaveLength(1);
      expect(
        await dbs.db.select().from(payment).where(eq(payment.bookingId, b.id)),
      ).toHaveLength(1);
    });
  });

  describe('POST /api/properties/:id/archive|unarchive', () => {
    it('archives a property (200); the owner still lists it', async () => {
      const prop = await createProperty('Prop Archive Villa');
      const res = await request(server())
        .post(`/api/properties/${prop.id}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<PropertyResponse>(res).archivedAt).not.toBeNull();

      const list = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set('Authorization', `Bearer ${tokenA}`)
          .expect(200),
      );
      expect(list.map((p) => p.id)).toContain(prop.id);
    });

    /**
     * The derivation payoff (ADR-0005). A Unit archived on its own account, then
     * caught up in a whole-Property archive, must survive the Property being
     * unarchived - which a cascade write could not do without a second marker.
     */
    it('archives Units by derivation and unarchive restores exactly the not-self-archived set', async () => {
      const prop = await createProperty('Derivation Villa');
      const a = await addUnit(prop.id, 'Room A');
      await addUnit(prop.id, 'Room B');
      await addUnit(prop.id, 'Room C');

      // A retired on its own account.
      await request(server())
        .post(`/api/units/${a.id}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      // Then the whole property retired for the season.
      await request(server())
        .post(`/api/properties/${prop.id}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      // While the property is archived its page is gone (ADR-0006).
      await getPublic(prop.slug).expect(404);

      // Season ends: unarchive the property.
      await request(server())
        .post(`/api/properties/${prop.id}/unarchive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      // B and C are back; A stays archived because ITS OWN flag is still set.
      const res = await getPublic(prop.slug).expect(200);
      const names = bodyOf<PublicPropertyResponse>(res).units.map(
        (u) => u.name,
      );
      expect(names.sort()).toEqual(['Room B', 'Room C']);

      // And the owner still sees A as archived, B/C as active.
      const owned = await listUnits(prop.id);
      const byName = Object.fromEntries(
        owned.map((u) => [u.name, u.archivedAt]),
      );
      expect(byName['Room A']).not.toBeNull();
      expect(byName['Room B']).toBeNull();
      expect(byName['Room C']).toBeNull();
    });

    it('404s an unknown property id', async () => {
      await request(server())
        .post(`/api/properties/${randomUUID()}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });
  });

  describe('publishable excludes archived (ADR-0005, api-spec §4.3)', () => {
    it('a property whose only priced unit is archived is not publishable', async () => {
      const { id: propId } = await seedProperty(tenantAId, {
        photos: ['x.jpg'],
      });
      const unitId = await seedUnit(tenantAId, propId, 750_000n);
      expect((await getProperty(propId)).publishable).toBe(true);

      await request(server())
        .post(`/api/units/${unitId}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect((await getProperty(propId)).publishable).toBe(false);
    });

    it('an archived property reports publishable:false', async () => {
      const { id: propId } = await seedProperty(tenantAId, {
        photos: ['x.jpg'],
      });
      await seedUnit(tenantAId, propId, 750_000n);
      expect((await getProperty(propId)).publishable).toBe(true);

      const res = await request(server())
        .post(`/api/properties/${propId}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<PropertyResponse>(res).publishable).toBe(false);
    });
  });

  describe('public page (ADR-0006, api-spec §4.7)', () => {
    it('drops an archived unit but keeps the active ones', async () => {
      const prop = await createProperty('Mixed Villa');
      await addUnit(prop.id, 'Kept Room');
      const gone = await addUnit(prop.id, 'Retired Room');
      await request(server())
        .post(`/api/units/${gone.id}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const res = await getPublic(prop.slug).expect(200);
      const names = bodyOf<PublicPropertyResponse>(res).units.map(
        (u) => u.name,
      );
      expect(names).toEqual(['Kept Room']);
    });

    it('404s an archived property, then unarchive restores the exact URL', async () => {
      const prop = await createProperty('Retired Villa');
      await addUnit(prop.id, 'Room');
      await getPublic(prop.slug).expect(200);

      await request(server())
        .post(`/api/properties/${prop.id}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      await getPublic(prop.slug).expect(404); // same shape as an unknown slug

      await request(server())
        .post(`/api/properties/${prop.id}/unarchive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const res = await getPublic(prop.slug).expect(200); // exact URL back
      expect(bodyOf<PublicPropertyResponse>(res).slug).toBe(prop.slug);
    });
  });

  describe('delete still works, and its 409 now names archive', () => {
    it('deletes a never-booked unit (204), unchanged', async () => {
      const prop = await createProperty('Deletable Villa');
      const u = await addUnit(prop.id, 'Doomed Room');
      await request(server())
        .delete(`/api/units/${u.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);
    });

    it('409s a booked unit and points to archive as the exit', async () => {
      const { id: propId } = await seedProperty(tenantAId);
      const unitId = await seedUnit(tenantAId, propId, 1_000_000n);
      await dbs.db.insert(booking).values({
        tenantId: tenantAId,
        unitId,
        source: 'direct',
        status: 'confirmed',
        checkIn: daysFromToday(10),
        checkOut: daysFromToday(12),
        guestName: 'Incoming',
      });

      const res = await request(server())
        .delete(`/api/units/${unitId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(409);
      expect(bodyOf<{ message: string }>(res).message).toMatch(/archive/i);
    });
  });

  describe('tenant isolation (AC #6)', () => {
    it("404s archiving another tenant's unit", async () => {
      const { id: propId } = await seedProperty(tenantBId);
      const bUnit = await seedUnit(tenantBId, propId, 1_000_000n);
      await request(server())
        .post(`/api/units/${bUnit}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
      // B's unit stays active - A's request must not have reached it.
      const [row] = await dbs.db
        .select({ archivedAt: unit.archivedAt })
        .from(unit)
        .where(eq(unit.id, bUnit));
      expect(row.archivedAt).toBeNull();
    });

    it("404s archiving another tenant's property", async () => {
      const { id: bProp } = await seedProperty(tenantBId);
      await request(server())
        .post(`/api/properties/${bProp}/archive`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
      const [row] = await dbs.db
        .select({ archivedAt: property.archivedAt })
        .from(property)
        .where(eq(property.id, bProp));
      expect(row.archivedAt).toBeNull();
    });
  });

  /**
   * M4 constraint, recorded now so the channel-sync build honours it (ADR-0005,
   * AC #5): archiving a Unit must NOT drop its existing bookings from the iCal
   * EXPORT feed, or an OTA would see those nights as free and resell them - a real
   * double-booking. There is no export code yet (M4), so this is a placeholder,
   * not a silent gap.
   */
  it.todo(
    'M4: an archived unit still exports its existing bookings to iCal (archive-blind export)',
  );
});
