import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import { appUser, tenant } from '@sambung/db';
import type { AuthResponse, MeResponse } from '@sambung/shared';
import * as dbErrorMap from '../common/db-error/db-error.map';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';

// Integration test for FR-AUTH-1 — runs against the real database.
describe('Auth (FR-AUTH-1)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const email = () => `auth-test+${randomUUID()}@test.dev`;
  const server = () => app.getHttpServer() as Server;
  // supertest types res.body as `any`; cast at the boundary so tests stay typed.
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  async function register(over: Record<string, unknown> = {}) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: 'Test Co',
        email: email(),
        password: 'supersecret1',
        ...over,
      });
    const body = res.body as Partial<AuthResponse>;
    if (body.tenant?.id) createdTenantIds.push(body.tenant.id);
    return res;
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
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  it('register creates a tenant + owner and starts a session', async () => {
    const res = await register({ tenantName: 'Bali Breeze' });
    const auth = bodyOf<AuthResponse>(res);
    expect(res.status).toBe(201);
    expect(auth.accessToken).toEqual(expect.any(String));
    expect(auth.user.role).toBe('owner');
    expect(auth.tenant.name).toBe('Bali Breeze');
    // password hash must never be exposed
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    // refresh token is an httpOnly cookie, not in the body
    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toMatch(/refresh_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(res.body).not.toHaveProperty('refreshToken');
  });

  it('GET /me returns the caller session, scoped to their tenant', async () => {
    const reg = bodyOf<AuthResponse>(
      await register({ tenantName: 'My Villa' }),
    );
    const res = await request(server())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${reg.accessToken}`);
    const me = bodyOf<MeResponse>(res);
    expect(res.status).toBe(200);
    expect(me.user.email).toBe(reg.user.email);
    expect(me.tenant.id).toBe(reg.tenant.id);
  });

  it('rejects /me without a token (401)', async () => {
    await request(server()).get('/api/auth/me').expect(401);
  });

  it('rejects /me with a garbage token (401)', async () => {
    await request(server())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.jwt')
      .expect(401);
  });

  it('rejects a duplicate email (409)', async () => {
    const addr = email();
    await register({ email: addr });
    const dup = await register({ email: addr });
    expect(dup.status).toBe(409);
  });

  it('handles a concurrent duplicate signup as 409, never 500', async () => {
    const addr = email();
    const send = () =>
      request(server())
        .post('/api/auth/register')
        .send({ tenantName: 'Race Co', email: addr, password: 'supersecret1' });
    const [r1, r2] = await Promise.all([send(), send()]);
    for (const r of [r1, r2]) {
      const b = r.body as Partial<AuthResponse>;
      if (b.tenant?.id) createdTenantIds.push(b.tenant.id);
    }
    // Exactly one wins (201); the other loses at the DB unique constraint → 409.
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([201, 409]);
  });

  // api-spec §5.3 as an assertion rather than a comment: "the client cannot
  // tell (and must not care) which layer refused". Two layers reject a
  // duplicate email - the app's pre-check (a fast path, to skip bcrypt) and the
  // citext UNIQUE that actually guarantees it - and their responses must be
  // indistinguishable. They are, because both come from the same factory: the
  // pre-check throws emailTaken(), and DbErrorInterceptor maps
  // app_user_email_key to emailTaken too.
  //
  // The constraint path is forced, not raced. Two concurrent signups only
  // sometimes overlap - measured, the race test above catches a broken map
  // roughly 1 run in 4 - and a §5.3 comparison that quietly falls back to the
  // pre-check compares a response to itself and passes vacuously. So instead:
  // let a signup clear the pre-check, then steal its email while it is busy
  // hashing.
  it('the pre-check and the constraint are indistinguishable to a client', async () => {
    // Layer 1: the row already exists, so the pre-check refuses before bcrypt.
    const taken = email();
    await register({ email: taken });
    const fromPreCheck = await register({ email: taken });
    expect(fromPreCheck.status).toBe(409);

    // Attribution. Timing would work (a pre-check rejection returns in
    // milliseconds because it short-circuits before hashing) but it calibrates
    // the test to this machine's bcrypt: on a ~1.3x faster CPU the threshold
    // fails while the behaviour is still correct. Watching the map itself is
    // exact and portable - if it produced a response, the constraint fired.
    const mapped = jest.spyOn(dbErrorMap, 'mapDbError');

    // `.then()` starts the request now rather than on await. The pre-check runs
    // within a few ms; bcrypt(12) then holds the window open (~205ms here), so
    // stealing the email at 80ms lands inside it. Contention only widens the
    // window - the risk is a faster box, and the spy above removes it.
    const stolen = email();
    const inFlight = request(server())
      .post('/api/auth/register')
      .send({
        tenantName: 'Stolen Co',
        email: stolen,
        password: 'supersecret1',
      })
      .then((r) => r);

    await new Promise((r) => setTimeout(r, 80));
    const [thief] = await dbs.db
      .insert(tenant)
      .values({ name: 'Thief Co' })
      .returning({ id: tenant.id });
    createdTenantIds.push(thief.id);
    // If this throws, the signup already inserted and the premise is broken -
    // loudly, rather than by silently testing the pre-check twice.
    await dbs.db.insert(appUser).values({
      tenantId: thief.id,
      email: stolen,
      passwordHash: 'x',
      role: 'owner',
    });

    const fromConstraint = await inFlight;

    // Read and restore before asserting: a throw here would otherwise leave the
    // spy installed for the rest of the file.
    const constraintFired = mapped.mock.results.some(
      (r) => r.value !== undefined,
    );
    mapped.mockRestore();

    // Asserted FIRST, because it is what makes the rest meaningful: the map
    // turned a real violation into this response, so the pre-check demonstrably
    // passed and the 409 came from the constraint. Had the pre-check quietly
    // caught it instead, the body comparison below would be a tautology and
    // would pass green.
    expect(constraintFired).toBe(true);
    expect(fromConstraint.status).toBe(409);
    expect(fromConstraint.body).toEqual(fromPreCheck.body);
  });

  it('rejects invalid input at the boundary (400)', async () => {
    await request(server())
      .post('/api/auth/register')
      .send({ tenantName: 'x', email: 'not-an-email', password: 'short' })
      .expect(400);
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    const addr = email();
    await register({ email: addr });

    const ok = await request(server())
      .post('/api/auth/login')
      .send({ email: addr, password: 'supersecret1' });
    expect(ok.status).toBe(200);
    expect(bodyOf<AuthResponse>(ok).accessToken).toEqual(expect.any(String));

    const bad = await request(server())
      .post('/api/auth/login')
      .send({ email: addr, password: 'wrongpassword' });
    expect(bad.status).toBe(401);
  });

  it('keeps each owner scoped to their own tenant', async () => {
    const a = bodyOf<AuthResponse>(await register({ tenantName: 'Tenant A' }));
    const b = bodyOf<AuthResponse>(await register({ tenantName: 'Tenant B' }));
    expect(a.tenant.id).not.toBe(b.tenant.id);

    const meA = bodyOf<MeResponse>(
      await request(server())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${a.accessToken}`),
    );
    expect(meA.tenant.name).toBe('Tenant A');
    expect(meA.tenant.id).not.toBe(b.tenant.id);
  });
});
