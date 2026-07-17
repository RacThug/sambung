import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { property, tenant, unit } from '@sambung/db';
import type { AuthResponse, PublicPropertyResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { PublicScope } from '../common/public-scope.service';
import { DbService } from '../db/db.service';
import { TenantDbService } from '../db/tenant-db.service';
import { testSlug } from '../test-helpers';

/**
 * The public property page (#46, api-spec §4.7) and the path an unauthenticated
 * request takes to the database (#77, ADR-0003).
 *
 * The interesting cases here are not "does it render" - they are what a Visitor
 * must NOT be able to see, and what must not break when an Owner edits.
 */
describe('Public property page', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  // Tenant A: a complete property. Tenant B: a neighbour whose data must never
  // appear in A's payload.
  const slugA = testSlug();
  const slugB = testSlug();
  let tokenA: string;
  let propAId: string;

  async function registerTenant(name: string) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: name,
        email: `pub+${randomUUID()}@test.dev`,
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

    const a = await registerTenant('Public Tenant A');
    const b = await registerTenant('Public Tenant B');
    tokenA = a.accessToken;

    const [pa] = await dbs.db
      .insert(property)
      .values({
        tenantId: a.tenant.id,
        name: 'Seminyak Beach Villa',
        slug: slugA,
        address: 'Jl. Kayu Aya, Seminyak',
        description: 'Steps from the beach.',
        licenseNo: 'NIB-1234567890',
        photos: ['photo-a-1.jpg', 'photo-a-2.jpg'],
      })
      .returning({ id: property.id });
    propAId = pa.id;
    await dbs.db.insert(unit).values([
      {
        propertyId: pa.id,
        tenantId: a.tenant.id,
        name: 'Whole Villa',
        basePriceIdr: 3_500_000n,
        maxGuests: 4,
        minStay: 2,
      },
    ]);

    const [pb] = await dbs.db
      .insert(property)
      .values({
        tenantId: b.tenant.id,
        name: 'Neighbour Villa',
        slug: slugB,
        licenseNo: 'NIB-SECRET-B',
        photos: ['photo-b-1.jpg'],
      })
      .returning({ id: property.id });
    await dbs.db.insert(unit).values({
      propertyId: pb.id,
      tenantId: b.tenant.id,
      name: 'B Room',
      basePriceIdr: 999_000n,
    });
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  it('serves a property to a Visitor with no token at all', async () => {
    const res = await request(server()).get(`/api/public/properties/${slugA}`);
    expect(res.status).toBe(200);
    const body = bodyOf<PublicPropertyResponse>(res);
    expect(body.name).toBe('Seminyak Beach Villa');
    expect(body.slug).toBe(slugA);
    expect(body.units).toHaveLength(1);
    expect(body.units[0].basePriceIdr).toBe(3_500_000);
  });

  /**
   * The #77 money shot. A Visitor has no principal, so before ADR-0003 this
   * request either returned zero rows (cold connection) or errored 22P02 (warm
   * one). It must now read exactly ONE tenant's public projection - and nothing
   * of the neighbour's, whose property and units sit right beside it.
   */
  it('reads exactly one tenant’s property and nothing of another’s', async () => {
    const res = await request(server()).get(`/api/public/properties/${slugA}`);
    expect(res.status).toBe(200);
    const body = bodyOf<PublicPropertyResponse>(res);
    // The Visitor's scope was resolved from slugA, so B's units must not appear
    // even though the units query could have matched them without RLS.
    expect(body.units.map((u) => u.name)).toEqual(['Whole Villa']);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Neighbour Villa');
    expect(serialized).not.toContain('B Room');
    expect(serialized).not.toContain(slugB);
  });

  it('404s an unknown slug', async () => {
    await request(server())
      .get(`/api/public/properties/${testSlug()}`)
      .expect(404);
  });

  it('never leaks the license value, only the badge', async () => {
    const res = await request(server()).get(`/api/public/properties/${slugA}`);
    const body = bodyOf<PublicPropertyResponse>(res);
    expect(body.verified).toBe(true);
    expect(JSON.stringify(body)).not.toContain('NIB-1234567890');
    expect(body).not.toHaveProperty('licenseNo');
  });

  it('exposes exactly the public field set - no PII, no tenant internals', async () => {
    const res = await request(server()).get(`/api/public/properties/${slugA}`);
    const body = bodyOf<PublicPropertyResponse>(res);
    // Pinned, not spot-checked: a new column on `property` must not be able to
    // arrive here silently. If this fails, decide - don't just update it.
    expect(Object.keys(body).sort()).toEqual([
      'address',
      'description',
      'name',
      'photos',
      'slug',
      'units',
      'verified',
    ]);
    expect(Object.keys(body.units[0]).sort()).toEqual([
      'basePriceIdr',
      'id',
      'maxGuests',
      'minStay',
      'name',
    ]);
    expect(Object.keys(body.photos[0])).toEqual(['url']);
  });

  it('shows the badge only when a license is on file (FR-PROP-3)', async () => {
    const slug = testSlug();
    const [p] = await dbs.db
      .insert(property)
      .values({
        tenantId: createdTenantIds[0],
        name: 'Unlicensed Villa',
        slug,
        photos: ['x.jpg'],
      })
      .returning({ id: property.id });
    const res = await request(server()).get(`/api/public/properties/${slug}`);
    expect(res.status).toBe(200);
    expect(bodyOf<PublicPropertyResponse>(res).verified).toBe(false);
    await dbs.db.delete(property).where(eq(property.id, p.id));
  });

  /**
   * ADR-0004. `publishable` is an Owner's checklist, not a gate: a page that
   * vanished because someone deleted a photo would kill a link already pasted
   * into an OTA profile, silently, on an edit nobody thought was about the URL.
   */
  it('renders a property that is not publishable (no photos, no priced unit)', async () => {
    const slug = testSlug();
    const [p] = await dbs.db
      .insert(property)
      .values({ tenantId: createdTenantIds[0], name: 'Bare Villa', slug })
      .returning({ id: property.id });
    await dbs.db.insert(unit).values({
      propertyId: p.id,
      tenantId: createdTenantIds[0],
      name: 'Placeholder',
      basePriceIdr: 0n, // storable, but not sellable - never counts as priced
    });

    const res = await request(server()).get(`/api/public/properties/${slug}`);
    expect(res.status).toBe(200);
    const body = bodyOf<PublicPropertyResponse>(res);
    expect(body.photos).toEqual([]);
    expect(body.units[0].basePriceIdr).toBe(0);
    await dbs.db.delete(property).where(eq(property.id, p.id));
  });

  /**
   * Layer 2, alone. The test above passes even with RLS switched off, because
   * the repository also carries `WHERE tenant_id` - so on its own it proves the
   * app filter, not the database. This one issues a query with NO filter under a
   * Visitor principal: only the GUC that `enterFromSlug` caused can scope it.
   *
   * Same standard as properties.spec.ts for the authenticated path - a claim
   * about two layers is worth nothing if either is only ever exercised behind
   * the other (architecture §3.3).
   */
  it('RLS scopes a Visitor’s query with no tenant filter at all', async () => {
    const scope = app.get(PublicScope);
    const tenantDb = app.get(TenantDbService);
    const cls = app.get(ClsService);

    const rows = await cls.run(async () => {
      await scope.enterFromSlug(slugA);
      return tenantDb.run((tx) => tx.select().from(property)); // no `where`
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((p) => p.tenantId === createdTenantIds[0])).toBe(true);
    expect(rows.map((p) => p.slug)).not.toContain(slugB);
  });

  /**
   * The gap #77 was filed for. A public route that forgets to enter a scope must
   * fail LOUDLY rather than quietly reading nothing - which is what it did
   * before #74/#76, differently depending on whether the pooled connection was
   * cold (zero rows) or warm (22P02).
   */
  it('throws rather than querying when no scope was entered', async () => {
    const tenantDb = app.get(TenantDbService);
    const cls = app.get(ClsService);
    await expect(
      cls.run(() => tenantDb.run((tx) => tx.select().from(property))),
    ).rejects.toThrow(/Tenant context is empty/);
  });

  it('keeps the slug when the property is renamed (ADR-0004)', async () => {
    await request(server())
      .patch(`/api/properties/${propAId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Seminyak Beach Villa & Spa' })
      .expect(200);

    // The address the guest already has must still resolve, to the new name.
    const res = await request(server()).get(`/api/public/properties/${slugA}`);
    expect(res.status).toBe(200);
    expect(bodyOf<PublicPropertyResponse>(res).name).toBe(
      'Seminyak Beach Villa & Spa',
    );
  });
});
