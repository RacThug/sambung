import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { inArray } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { property, tenant } from '@sambung/db';
import type { AuthResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { TenantDbService } from '../db/tenant-db.service';

// Tenant isolation (FR-AUTH-3, boss fight #5) — app-layer proof against a real DB.
describe('Tenant isolation (properties)', () => {
  let app: INestApplication;
  let dbs: DbService;
  let tenantDb: TenantDbService;
  let cls: ClsService;
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

    const a = await registerTenant('Tenant A');
    const b = await registerTenant('Tenant B');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    [propA] = await dbs.db
      .insert(property)
      .values({ tenantId: a.tenant.id, name: 'A Villa' })
      .returning({ id: property.id });
    [propB] = await dbs.db
      .insert(property)
      .values({ tenantId: b.tenant.id, name: 'B Villa' })
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

  // Layer 2 (RLS): query with NO app-level tenant filter — the database itself
  // must scope it via the GUC set from the request's tenant context.
  it('RLS scopes queries even without an explicit tenant filter', async () => {
    const props = await cls.run(async () => {
      cls.set('principal', {
        userId: 'test',
        tenantId: tenantAId,
        role: 'owner',
      });
      return tenantDb.run((tx) => tx.select().from(property)); // no `where`
    });
    expect(props.length).toBeGreaterThan(0);
    expect(props.every((p) => p.tenantId === tenantAId)).toBe(true);
    expect(props.map((p) => p.id)).not.toContain(propB.id);
  });
});
