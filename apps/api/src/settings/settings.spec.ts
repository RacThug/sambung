import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { appUser, tenant } from '@sambung/db';
import {
  DEFAULT_GALLERY_CAP,
  PHOTO_GALLERY_CEILING,
  type AuthResponse,
  type TenantSettingsResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';

// Tenant settings (#67, ADR-0030) over real HTTP + DB. Covers the contract, the
// role gate (the first one in the codebase) and tenant isolation.
describe('Tenant settings', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  const PASSWORD = 'supersecret1';

  async function registerTenant(name: string) {
    const email = `settings+${randomUUID()}@test.dev`;
    const res = await request(server())
      .post('/api/auth/register')
      .send({ tenantName: name, email, password: PASSWORD })
      .expect(201);
    const auth = bodyOf<AuthResponse>(res);
    createdTenantIds.push(auth.tenant.id);
    return { ...auth, email };
  }

  /**
   * A staff token, earned rather than forged: demote the registered user in the
   * database and log in again, so the role travels the real path (row → login →
   * token → guard). There is no invite endpoint yet - that is #57 - and forging
   * a JWT here would test the guard against a token no login could ever mint.
   */
  async function staffTokenFor(email: string): Promise<string> {
    await dbs.db
      .update(appUser)
      .set({ role: 'staff' })
      .where(eq(appUser.email, email));
    const res = await request(server())
      .post('/api/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const auth = bodyOf<AuthResponse>(res);
    expect(auth.user.role).toBe('staff');
    return auth.accessToken;
  }

  const getSettings = (token: string) =>
    request(server())
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`);

  const patchSettings = (token: string, body: Record<string, unknown>) =>
    request(server())
      .patch('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    await app.init();
    dbs = app.get(DbService);
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  it('starts at the default cap and reports the system ceiling', async () => {
    const { accessToken } = await registerTenant('Settings Default');
    const res = await getSettings(accessToken).expect(200);
    const body = bodyOf<TenantSettingsResponse>(res);
    expect(body.galleryCap).toBe(DEFAULT_GALLERY_CAP);
    expect(body.galleryCeiling).toBe(PHOTO_GALLERY_CEILING);
  });

  it('an owner can raise and lower the cap, and the read reflects it', async () => {
    const { accessToken } = await registerTenant('Settings Owner');

    const raised = await patchSettings(accessToken, { galleryCap: 75 }).expect(
      200,
    );
    expect(bodyOf<TenantSettingsResponse>(raised).galleryCap).toBe(75);

    const lowered = await patchSettings(accessToken, { galleryCap: 5 }).expect(
      200,
    );
    expect(bodyOf<TenantSettingsResponse>(lowered).galleryCap).toBe(5);

    const read = await getSettings(accessToken).expect(200);
    expect(bodyOf<TenantSettingsResponse>(read).galleryCap).toBe(5);
  });

  it('refuses a cap outside 1..ceiling (400) and leaves the stored value alone', async () => {
    const { accessToken } = await registerTenant('Settings Bounds');
    await patchSettings(accessToken, { galleryCap: 40 }).expect(200);

    await patchSettings(accessToken, { galleryCap: 0 }).expect(400);
    await patchSettings(accessToken, {
      galleryCap: PHOTO_GALLERY_CEILING + 1,
    }).expect(400);
    await patchSettings(accessToken, { galleryCap: 12.5 }).expect(400);
    await patchSettings(accessToken, { galleryCap: '30' }).expect(400);

    const read = await getSettings(accessToken).expect(200);
    expect(bodyOf<TenantSettingsResponse>(read).galleryCap).toBe(40);
  });

  it('treats an empty PATCH as a no-op that returns current settings', async () => {
    const { accessToken } = await registerTenant('Settings NoOp');
    await patchSettings(accessToken, { galleryCap: 22 }).expect(200);
    const res = await patchSettings(accessToken, {}).expect(200);
    expect(bodyOf<TenantSettingsResponse>(res).galleryCap).toBe(22);
  });

  describe('the role gate', () => {
    it('lets staff READ the settings - the property workbench needs the cap', async () => {
      const { accessToken, email } = await registerTenant('Settings StaffRead');
      await patchSettings(accessToken, { galleryCap: 17 }).expect(200);

      const staff = await staffTokenFor(email);
      const res = await getSettings(staff).expect(200);
      expect(bodyOf<TenantSettingsResponse>(res).galleryCap).toBe(17);
    });

    it('refuses a staff WRITE (403) and changes nothing', async () => {
      const { accessToken, email } = await registerTenant(
        'Settings StaffWrite',
      );
      await patchSettings(accessToken, { galleryCap: 9 }).expect(200);

      const staff = await staffTokenFor(email);
      await patchSettings(staff, { galleryCap: 60 }).expect(403);

      const res = await getSettings(staff).expect(200);
      expect(bodyOf<TenantSettingsResponse>(res).galleryCap).toBe(9);
    });

    it('refuses an unauthenticated caller (401) on both verbs', async () => {
      await request(server()).get('/api/settings').expect(401);
      await request(server())
        .patch('/api/settings')
        .send({ galleryCap: 50 })
        .expect(401);
    });
  });

  it("one tenant's cap is invisible and untouchable from another", async () => {
    const a = await registerTenant('Settings Tenant A');
    const b = await registerTenant('Settings Tenant B');

    await patchSettings(a.accessToken, { galleryCap: 11 }).expect(200);
    await patchSettings(b.accessToken, { galleryCap: 88 }).expect(200);

    // Each token sees only its own row - the singular resource carries no id to
    // tamper with, so this proves the scoping rather than an ownership check.
    const readA = await getSettings(a.accessToken).expect(200);
    const readB = await getSettings(b.accessToken).expect(200);
    expect(bodyOf<TenantSettingsResponse>(readA).galleryCap).toBe(11);
    expect(bodyOf<TenantSettingsResponse>(readB).galleryCap).toBe(88);

    // And B's write did not rewrite every tenant's cap (a missing WHERE would).
    const rows = await dbs.db
      .select({ id: tenant.id, galleryCap: tenant.galleryCap })
      .from(tenant)
      .where(inArray(tenant.id, [a.tenant.id, b.tenant.id]));
    expect(rows.find((r) => r.id === a.tenant.id)?.galleryCap).toBe(11);
    expect(rows.find((r) => r.id === b.tenant.id)?.galleryCap).toBe(88);
  });
});
