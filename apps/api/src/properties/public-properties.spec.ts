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
import { TenantContext } from '../common/tenant-context.service';
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

  /**
   * Found in review. `%00` decodes to a NUL byte, which Postgres rejects with
   * 22021 - not a constraint violation, so unmapped, so a 500 on the one route
   * with no authentication in front of it. The controller's comment claimed a
   * malformed slug was "simply a 404"; parameterizing the query stops injection,
   * not this. SlugParamPipe refuses it before any lookup.
   */
  it('404s a malformed slug rather than 500ing (never reaches the database)', async () => {
    for (const slug of [
      '%00',
      '%00villa',
      'Villa Bali',
      'UPPERCASE',
      '-leading',
      'trailing-',
      'double--dash',
      '../../etc/passwd',
      "'--",
      '<script>alert(1)</script>',
    ]) {
      const res = await request(server()).get(`/api/public/properties/${slug}`);
      expect([slug, res.status]).toEqual([slug, 404]);
    }
  });

  it('never leaks internals in the 404 body', async () => {
    // api-spec §1: errors carry no SQL, no constraint names, no stack.
    const res = await request(server()).get('/api/public/properties/%00');
    expect(JSON.stringify(res.body)).not.toMatch(/22021|slug|postgres|select/i);
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
    // `depositPct` was ADDED deliberately (#52, ADR-0015): a payment term the
    // guest sees at checkout anyway, so the funnel can preview the deposit before
    // the redirect. Non-PII, unlike licenseNo.
    expect(Object.keys(body).sort()).toEqual([
      'address',
      'depositPct',
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

  /**
   * Found in review. PublicScope is globally injectable, so nothing stopped a
   * guarded route from calling enterFromSlug and silently turning its Owner into
   * a Visitor of whichever tenant owns that slug - every query after it running
   * under the wrong scope. TenantDbService.run would not have caught it: it
   * compares principals only inside an already-open transaction.
   */
  it('refuses to re-mint a principal over an existing one', async () => {
    const cls = app.get(ClsService);
    const tenantCtx = app.get(TenantContext);
    const scope = app.get(PublicScope);

    await expect(
      cls.run(async () => {
        // An authenticated request: the guard mints the Owner first...
        tenantCtx.set({
          kind: 'user',
          userId: 'test',
          tenantId: createdTenantIds[0],
          role: 'owner',
        });
        // ...then something reaches for the public path in the same request.
        await scope.enterFromSlug(slugB);
      }),
    ).rejects.toThrow(/already minted/);
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

  /**
   * The OG stub for link-preview crawlers (#87, ADR-0019, architecture §6 tier
   * 2). Caddy proxies a known-crawler UA on /p/:slug here; the route reuses the
   * SAME tenant-scoped read as the JSON page, so its scoping, archived→404, and
   * malformed-slug→404 are inherited, not re-implemented. These assert the stub
   * carries the OG values a preview needs and that a crawler sees no more than a
   * Visitor does.
   */
  describe('OG stub for link-preview crawlers (#87)', () => {
    // NB: the rename test above ran first and set A's name to "... & Spa", so the
    // title carries an "&" - which the stub must HTML-escape in the attribute.
    it('serves static HTML with the property name, description, and hero photo', async () => {
      const res = await request(server()).get(
        `/api/public/properties/${slugA}/og`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');

      // AC (a): og:title (name), og:description, og:image (hero photo).
      expect(res.text).toContain(
        // "&" in the renamed title is HTML-escaped in the attribute.
        `<meta property="og:title" content="Seminyak Beach Villa &amp; Spa - Book direct">`,
      );
      expect(res.text).toContain(
        '<meta property="og:description" content="Steps from the beach.">',
      );
      // publicUrl(key) is STORAGE_PUBLIC_BASE_URL + the first photo key.
      expect(res.text).toMatch(
        /<meta property="og:image" content="[^"]*photo-a-1\.jpg">/,
      );
      // A human who lands here is bounced to the real /p/:slug page.
      expect(res.text).toContain(`/p/${slugA}`);
    });

    /**
     * AC #3 (#127): og:url / canonical come from TRUSTED CONFIG (WEB_BASE_URL),
     * never the inbound Host. A crawler (or an attacker) that sends a forged Host
     * must not steer the canonical the preview points at onto their own origin.
     */
    it('derives og:url/canonical from WEB_BASE_URL, ignoring a spoofed Host', async () => {
      const base = process.env.WEB_BASE_URL; // set by the test .env
      expect(base).toBeTruthy();
      const res = await request(server())
        .get(`/api/public/properties/${slugA}/og`)
        .set('Host', 'evil.example.com')
        .set('X-Forwarded-Host', 'evil.example.com')
        .set('X-Forwarded-Proto', 'https');
      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `<meta property="og:url" content="${base}/p/${slugA}">`,
      );
      expect(res.text).toContain(
        `<link rel="canonical" href="${base}/p/${slugA}">`,
      );
      // The client-settable Host never reaches the advertised canonical.
      expect(res.text).not.toContain('evil.example.com');
    });

    it('reveals nothing of a neighbour tenant (same scope as the JSON page)', async () => {
      const res = await request(server()).get(
        `/api/public/properties/${slugA}/og`,
      );
      expect(res.text).not.toContain('Neighbour Villa');
      expect(res.text).not.toContain(slugB);
      // No PII/internal ever belonged in an OG card, and the license never
      // reaches this projection to begin with.
      expect(res.text).not.toContain('NIB-');
    });

    it('404s an unknown slug', async () => {
      await request(server())
        .get(`/api/public/properties/${testSlug()}/og`)
        .expect(404);
    });

    it('404s a malformed slug before any lookup (SlugParamPipe)', async () => {
      for (const slug of ['%00', 'UPPERCASE', '../../etc/passwd']) {
        const res = await request(server()).get(
          `/api/public/properties/${slug}/og`,
        );
        expect([slug, res.status]).toEqual([slug, 404]);
      }
    });

    /**
     * ADR-0006: an archived Property is a deliberate take-down → public 404. The
     * crawler stub must inherit that, or a retired villa keeps previewing on
     * WhatsApp. It does, because getOgHtmlBySlug goes through getBySlug, which
     * returns null (→404) for an archived property.
     */
    it('404s an archived property, exactly like the JSON page', async () => {
      const slug = testSlug();
      const [p] = await dbs.db
        .insert(property)
        .values({
          tenantId: createdTenantIds[0],
          name: 'Retired Villa',
          slug,
          archivedAt: new Date(),
          photos: ['x.jpg'],
        })
        .returning({ id: property.id });

      await request(server()).get(`/api/public/properties/${slug}`).expect(404);
      await request(server())
        .get(`/api/public/properties/${slug}/og`)
        .expect(404);

      await dbs.db.delete(property).where(eq(property.id, p.id));
    });

    /**
     * The name and description are tenant-authored, and the stub is HTML we
     * serve. A name crafted to break out of the attribute must be escaped, not
     * reflected - otherwise the OG route is a stored-XSS vector on our origin.
     */
    it('HTML-escapes a hostile property name (no injection into the stub)', async () => {
      const slug = testSlug();
      const [p] = await dbs.db
        .insert(property)
        .values({
          tenantId: createdTenantIds[0],
          name: '"><script>alert(1)</script>',
          slug,
        })
        .returning({ id: property.id });

      const res = await request(server()).get(
        `/api/public/properties/${slug}/og`,
      );
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('<script>alert(1)</script>');
      expect(res.text).not.toContain('"><script>');
      expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

      await dbs.db.delete(property).where(eq(property.id, p.id));
    });
  });
});
