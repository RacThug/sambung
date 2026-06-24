import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { AuthResponse, MeResponse } from '@sambung/shared';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

// Integration test for FR-AUTH-1 — runs against the real database.
describe('Auth (FR-AUTH-1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await prisma.tenant.deleteMany({
        where: { id: { in: createdTenantIds } },
      });
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
