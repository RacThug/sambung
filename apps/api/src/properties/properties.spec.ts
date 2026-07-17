import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { inArray, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { property, tenant } from '@sambung/db';
import type { AuthResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';
import { PropertiesRepository } from './properties.repository';
import { testSlug } from '../test-helpers';

// Tenant isolation (FR-AUTH-3, boss fight #5) — app-layer proof against a real DB.
describe('Tenant isolation (properties)', () => {
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
        email: `iso+${randomUUID()}@test.dev`,
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

    const a = await registerTenant('Tenant A');
    const b = await registerTenant('Tenant B');
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
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  it('lists only the caller tenant’s properties', async () => {
    const res = await request(server())
      .get('/api/properties')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const ids = bodyOf<Array<{ id: string }>>(res).map((p) => p.id);
    expect(ids).toContain(propA.id);
    expect(ids).not.toContain(propB.id);
  });

  it('returns the caller’s own property by id', async () => {
    await request(server())
      .get(`/api/properties/${propA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
  });

  it('returns 404 for another tenant’s property id (the money shot)', async () => {
    await request(server())
      .get(`/api/properties/${propB.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });

  it('rejects unauthenticated access (401)', async () => {
    await request(server()).get('/api/properties').expect(401);
  });

  /** Run fn as tenant A's owner, the way a request would. */
  const asTenantA = <T>(fn: () => Promise<T>): Promise<T> =>
    cls.run(() => {
      tenantCtx.set({ userId: 'test', tenantId: tenantAId, role: 'owner' });
      return fn();
    });

  // Layer 2 (RLS): query with NO app-level tenant filter — the database itself
  // must scope it via the GUC set from the request's tenant context.
  it('RLS scopes queries even without an explicit tenant filter', async () => {
    const props = await asTenantA(
      () => tenantDb.run((tx) => tx.select().from(property)), // no `where`
    );
    expect(props.length).toBeGreaterThan(0);
    expect(props.every((p) => p.tenantId === tenantAId)).toBe(true);
    expect(props.map((p) => p.id)).not.toContain(propB.id);
  });

  // Layer 1 (the WHERE): the twin of the test above, and the reason
  // architecture.md §3.3 point 3 keeps a tenant filter on every query even
  // though RLS already scopes them.
  //
  // Without this, the filter is deletable with the suite green: RLS would
  // silently cover for it, and "two layers must both fail" would be a claim
  // with one layer tested. So point a TenantDbService at the OWNER connection -
  // that role bypasses every policy - and check the repository still scopes.
  // If a WHERE goes missing, this goes red and the RLS test above does not.
  it('the repository tenant filter scopes on its own, with RLS bypassed', async () => {
    const ownerDb = new TenantDbService(
      // Only DATABASE_URL is ever read; stubbing ConfigService beats booting a
      // second AppModule to change one string.
      {
        getOrThrow: () => process.env.DATABASE_URL,
      } as unknown as ConfigService,
      tenantCtx,
    );
    try {
      const repo = new PropertiesRepository(ownerDb, tenantCtx);
      const { bypassed, mine, foreign, all } = await asTenantA(async () => ({
        // Precondition, asserted on the connection UNDER TEST rather than on
        // DbService: if this connected as the app role, every assertion below
        // would pass because RLS covered for the filter - the exact "green for
        // the wrong reason" this test exists to rule out. row_security_active
        // is false only when the role genuinely bypasses policy.
        bypassed: await ownerDb.run(async (tx) => {
          const res = await tx.execute(
            sql`select row_security_active('property') as active`,
          );
          return (res.rows[0] as { active: boolean }).active;
        }),
        mine: await repo.findById(propA.id),
        foreign: await repo.findById(propB.id),
        all: await repo.findAll(),
      }));

      expect(bypassed).toBe(false);
      expect(mine?.id).toBe(propA.id);
      expect(foreign).toBeNull();
      expect(all.map((p) => p.id)).not.toContain(propB.id);
    } finally {
      await ownerDb.onModuleDestroy();
    }
  });
});
