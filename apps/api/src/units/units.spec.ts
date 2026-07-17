import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { inArray, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { property, tenant, unit } from '@sambung/db';
import type { AuthResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';
import { UnitsRepository } from './units.repository';
import { testSlug } from '../test-helpers';

// Tenant isolation (FR-AUTH-3, boss fight #5) for units - app-layer proof
// against a real DB. The twin-test structure mirrors properties.spec.ts on
// purpose: each of the two layers must be proven to hold WITHOUT the other, or
// "defense in depth" is a claim with one layer tested.
describe('Tenant isolation (units)', () => {
  let app: INestApplication;
  let dbs: DbService;
  let tenantDb: TenantDbService;
  let cls: ClsService;
  let tenantCtx: TenantContext;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  async function registerTenant(name: string) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: name,
        email: `unit-iso+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    const auth = bodyOf<AuthResponse>(res);
    createdTenantIds.push(auth.tenant.id);
    return auth;
  }

  let tokenA: string;
  let tenantAId: string;
  let propA: { id: string };
  let propB: { id: string };
  let unitA: { id: string };
  let unitB: { id: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);
    tenantDb = app.get(TenantDbService);
    cls = app.get(ClsService);
    tenantCtx = app.get(TenantContext);

    const a = await registerTenant('Unit Tenant A');
    const b = await registerTenant('Unit Tenant B');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    [propA] = await dbs.db
      .insert(property)
      .values({ tenantId: a.tenant.id, name: 'A Villa', slug: testSlug() })
      .returning({ id: property.id });
    [propB] = await dbs.db
      .insert(property)
      .values({ tenantId: b.tenant.id, name: 'B Villa', slug: testSlug() })
      .returning({ id: property.id });
    [unitA] = await dbs.db
      .insert(unit)
      .values({
        tenantId: a.tenant.id,
        propertyId: propA.id,
        name: 'A Room',
        basePriceIdr: 1_000_000n,
      })
      .returning({ id: unit.id });
    [unitB] = await dbs.db
      .insert(unit)
      .values({
        tenantId: b.tenant.id,
        propertyId: propB.id,
        name: 'B Room',
        basePriceIdr: 2_000_000n,
      })
      .returning({ id: unit.id });
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  it('lists only the caller tenant’s units', async () => {
    const res = await request(server())
      .get(`/api/properties/${propA.id}/units`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const ids = bodyOf<Array<{ id: string }>>(res).map((u) => u.id);
    expect(ids).toEqual([unitA.id]);
  });

  it('404s listing units under another tenant’s property', async () => {
    await request(server())
      .get(`/api/properties/${propB.id}/units`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });

  it('404s creating a unit under another tenant’s property, and creates nothing', async () => {
    await request(server())
      .post(`/api/properties/${propB.id}/units`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Trojan Room', basePriceIdr: 1 })
      .expect(404);

    const rows = await dbs.db
      .select()
      .from(unit)
      .where(inArray(unit.propertyId, [propB.id]));
    expect(rows.map((u) => u.name)).toEqual(['B Room']);
  });

  it('404s patching another tenant’s unit and leaves it unchanged', async () => {
    await request(server())
      .patch(`/api/units/${unitB.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Hijacked', basePriceIdr: 1 })
      .expect(404);

    const [row] = await dbs.db
      .select()
      .from(unit)
      .where(inArray(unit.id, [unitB.id]));
    expect(row.name).toBe('B Room');
    expect(row.basePriceIdr).toBe(2_000_000n);
  });

  it('404s deleting another tenant’s unit and leaves it standing', async () => {
    await request(server())
      .delete(`/api/units/${unitB.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    const rows = await dbs.db
      .select()
      .from(unit)
      .where(inArray(unit.id, [unitB.id]));
    expect(rows).toHaveLength(1);
  });

  it('rejects unauthenticated access (401)', async () => {
    await request(server())
      .get(`/api/properties/${propA.id}/units`)
      .expect(401);
  });

  /** Run fn as tenant A's owner, the way a request would. */
  const asTenantA = <T>(fn: () => Promise<T>): Promise<T> =>
    cls.run(() => {
      tenantCtx.set({ userId: 'test', tenantId: tenantAId, role: 'owner' });
      return fn();
    });

  // Layer 2 (RLS): query with NO app-level tenant filter - the database itself
  // must scope it via the GUC set from the request's tenant context.
  it('RLS scopes unit queries even without an explicit tenant filter', async () => {
    const units = await asTenantA(
      () => tenantDb.run((tx) => tx.select().from(unit)), // no `where`
    );
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u.tenantId === tenantAId)).toBe(true);
    expect(units.map((u) => u.id)).not.toContain(unitB.id);
  });

  // Layer 1 (the WHERE): the twin of the test above. Point a TenantDbService at
  // the OWNER connection - that role bypasses every policy - and check the
  // repository still scopes. If a WHERE goes missing, this goes red and the RLS
  // test above does not.
  it('the repository tenant filter scopes on its own, with RLS bypassed', async () => {
    const ownerDb = new TenantDbService(
      {
        getOrThrow: () => process.env.DATABASE_URL,
      } as unknown as ConfigService,
      tenantCtx,
    );
    try {
      const repo = new UnitsRepository(ownerDb, tenantCtx);
      const { bypassed, mine, foreign, listed, foreignProperty } =
        await asTenantA(async () => ({
          // Precondition, asserted on the connection UNDER TEST: if this
          // connected as the app role, everything below would pass because RLS
          // covered for the filter - the exact "green for the wrong reason" this
          // test rules out.
          bypassed: await ownerDb.run(async (tx) => {
            const res = await tx.execute(
              sql`select row_security_active('unit') as active`,
            );
            return (res.rows[0] as { active: boolean }).active;
          }),
          mine: await repo.findById(unitA.id),
          foreign: await repo.findById(unitB.id),
          listed: await repo.findByProperty(propB.id),
          foreignProperty: await repo.propertyExists(propB.id),
        }));

      expect(bypassed).toBe(false);
      expect(mine?.id).toBe(unitA.id);
      expect(foreign).toBeNull();
      expect(listed).toEqual([]);
      // The ownership check is what turns a foreign property into a 404 rather
      // than a 500 from the composite FK - it has to scope on its own too.
      expect(foreignProperty).toBe(false);
    } finally {
      await ownerDb.onModuleDestroy();
    }
  });
});
