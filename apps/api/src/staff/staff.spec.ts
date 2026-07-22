import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import {
  appUser,
  booking,
  membership,
  property,
  staffInvite,
  tenant,
  unit,
  userProperty,
} from '@sambung/db';
import type {
  AuthResponse,
  ConflictBody,
  InviteDto,
  InvitePreviewResponse,
  ListInvitesResponse,
  ListStaffResponse,
  PropertyResponse,
  StaffMemberDto,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import {
  MAILER,
  type EmailMessage,
  type Mailer,
} from '../notifications/mailer';
import { testSlug } from '../test-helpers';

/**
 * Staff invites + property-scoped RBAC (#57, FR-AUTH-2), over real HTTP and a
 * real database.
 *
 * The mailer is a recording fake, which is not merely convenient: the invite
 * token appears exactly ONCE, in the email body, and is never returned by the
 * API. So the only way to accept an invite here is the way a real invitee does
 * it - read the link out of the message. If the email ever stopped carrying a
 * usable link, most of this file would go red.
 */
describe('Staff invites and property-scoped RBAC', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];
  const sent: EmailMessage[] = [];
  let mailerFails = false;

  const fakeMailer: Mailer = {
    send: (message) => {
      if (mailerFails) return Promise.reject(new Error('mailer is down'));
      sent.push(message);
      return Promise.resolve();
    },
  };

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
  const PASSWORD = 'supersecret1';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function registerTenant(name: string) {
    const email = `staff+${randomUUID()}@test.dev`;
    const res = await request(server())
      .post('/api/auth/register')
      .send({ tenantName: name, email, password: PASSWORD })
      .expect(201);
    const body = bodyOf<AuthResponse>(res);
    createdTenantIds.push(body.tenant.id);
    return { ...body, email };
  }

  /** A property with one unit and one booking, so every scoped table has a row. */
  async function seedProperty(tenantId: string, name: string) {
    const [p] = await dbs.db
      .insert(property)
      .values({ tenantId, name, slug: testSlug() })
      .returning({ id: property.id });
    const [u] = await dbs.db
      .insert(unit)
      .values({
        tenantId,
        propertyId: p.id,
        name: `${name} Room`,
        basePriceIdr: 750_000n,
      })
      .returning({ id: unit.id });
    const [b] = await dbs.db
      .insert(booking)
      .values({
        tenantId,
        unitId: u.id,
        source: 'direct',
        status: 'confirmed',
        checkIn: '2027-05-01',
        checkOut: '2027-05-04',
      })
      .returning({ id: booking.id });
    return { propertyId: p.id, unitId: u.id, bookingId: b.id };
  }

  /** Invite someone, read the token out of the email, and accept it. Returns the
   * new staff member's session - the whole AC #3 path in one helper. */
  async function inviteAndAccept(
    ownerToken: string,
    propertyIds: string[],
  ): Promise<{
    token: string;
    userId: string;
    email: string;
    inviteId: string;
  }> {
    const email = `invitee+${randomUUID()}@test.dev`;
    const before = sent.length;
    const res = await request(server())
      .post('/api/auth/invites')
      .set(auth(ownerToken))
      .send({ email, propertyIds })
      .expect(201);
    const invite = bodyOf<InviteDto>(res);
    const link = tokenFromLastEmail(before);
    const accepted = await request(server())
      .post('/api/auth/invites/accept')
      .send({ token: link, password: PASSWORD })
      .expect(200);
    const session = bodyOf<AuthResponse>(accepted);
    return {
      token: session.accessToken,
      userId: session.user.id,
      email,
      inviteId: invite.id,
    };
  }

  /** The raw token, from the one email the API just sent. */
  function tokenFromLastEmail(sinceIndex: number): string {
    const message = sent[sinceIndex];
    expect(message).toBeDefined();
    const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(message.text);
    expect(match).not.toBeNull();
    return match![1];
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(fakeMailer)
      .compile();
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

  beforeEach(() => {
    mailerFails = false;
  });

  // --- AC #3: the invite lifecycle -------------------------------------------

  describe('the invite lifecycle', () => {
    it('emails a single-use link that sets a password and starts a session', async () => {
      const owner = await registerTenant('Invite Happy Path');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa One');
      const before = sent.length;

      const email = `invitee+${randomUUID()}@test.dev`;
      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({ email, propertyIds: [propertyId] })
        .expect(201);

      // The email is the ONLY carrier of the token, and it names what is granted.
      expect(sent).toHaveLength(before + 1);
      expect(sent[before].to).toBe(email);
      expect(sent[before].text).toContain('Villa One');
      const token = tokenFromLastEmail(before);

      // Preview first - what /invite/:token renders before asking for a password.
      const preview = bodyOf<InvitePreviewResponse>(
        await request(server())
          .get(`/api/auth/invites/token/${token}`)
          .expect(200),
      );
      expect(preview.email).toBe(email);
      expect(preview.tenantName).toBe('Invite Happy Path');
      expect(preview.propertyNames).toEqual(['Villa One']);

      const accepted = await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: PASSWORD })
        .expect(200);
      const session = bodyOf<AuthResponse>(accepted);
      expect(session.user.role).toBe('staff');
      expect(session.user.email).toBe(email);
      expect(session.tenant.id).toBe(owner.tenant.id);
      // A real session: the refresh cookie is set exactly as login sets it.
      const cookies = accepted.headers['set-cookie'] as unknown as string[];
      expect(cookies.join(';')).toContain('refresh_token=');

      // ...and the password works at the front door, not just here.
      await request(server())
        .post('/api/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
    });

    it('is single-use: the same token cannot be accepted twice', async () => {
      const owner = await registerTenant('Invite Single Use');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Once');
      const before = sent.length;
      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({
          email: `invitee+${randomUUID()}@test.dev`,
          propertyIds: [propertyId],
        })
        .expect(201);
      const token = tokenFromLastEmail(before);

      await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: PASSWORD })
        .expect(200);
      const second = await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: PASSWORD })
        .expect(409);
      expect(bodyOf<ConflictBody>(second)).toMatchObject({
        code: 'invite_not_acceptable',
        reason: 'accepted',
      });
    });

    it('two simultaneous accepts create exactly ONE staff account', async () => {
      // The reason the guarded UPDATE runs FIRST inside the accept transaction:
      // both requests read a live invite, and the row lock is what decides.
      const owner = await registerTenant('Invite Race');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Race');
      const before = sent.length;
      const email = `invitee+${randomUUID()}@test.dev`;
      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({ email, propertyIds: [propertyId] })
        .expect(201);
      const token = tokenFromLastEmail(before);

      const results = await Promise.all([
        request(server())
          .post('/api/auth/invites/accept')
          .send({ token, password: PASSWORD }),
        request(server())
          .post('/api/auth/invites/accept')
          .send({ token, password: PASSWORD }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);

      const users = await dbs.db
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.email, email));
      expect(users).toHaveLength(1);
    });

    it('refuses an expired token, and says so', async () => {
      const owner = await registerTenant('Invite Expiry');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Late');
      const before = sent.length;
      const res = await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({
          email: `invitee+${randomUUID()}@test.dev`,
          propertyIds: [propertyId],
        })
        .expect(201);
      const token = tokenFromLastEmail(before);

      // Age it past its TTL. The liveness comparison is the DATABASE's clock, so
      // moving the row is what makes this real - not mocking Date in Node.
      await dbs.db
        .update(staffInvite)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(staffInvite.id, bodyOf<InviteDto>(res).id));

      const refused = await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: PASSWORD })
        .expect(409);
      expect(bodyOf<ConflictBody>(refused)).toMatchObject({
        code: 'invite_not_acceptable',
        reason: 'expired',
      });
      // The preview agrees with the write - a holder reloading the page is told
      // the same thing, rather than watching a working page become a 404.
      await request(server())
        .get(`/api/auth/invites/token/${token}`)
        .expect(409);
    });

    it('refuses a revoked token', async () => {
      const owner = await registerTenant('Invite Revoke');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Gone');
      const before = sent.length;
      const created = bodyOf<InviteDto>(
        await request(server())
          .post('/api/auth/invites')
          .set(auth(owner.accessToken))
          .send({
            email: `invitee+${randomUUID()}@test.dev`,
            propertyIds: [propertyId],
          })
          .expect(201),
      );
      const token = tokenFromLastEmail(before);

      await request(server())
        .delete(`/api/auth/invites/${created.id}`)
        .set(auth(owner.accessToken))
        .expect(204);
      // Idempotent: revoking twice is not an error, the invite is already dead.
      await request(server())
        .delete(`/api/auth/invites/${created.id}`)
        .set(auth(owner.accessToken))
        .expect(204);

      const refused = await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: PASSWORD })
        .expect(409);
      expect(bodyOf<ConflictBody>(refused)).toMatchObject({
        code: 'invite_not_acceptable',
        reason: 'revoked',
      });
      // ...and it has left the owner's pending list.
      const list = bodyOf<ListInvitesResponse>(
        await request(server())
          .get('/api/auth/invites')
          .set(auth(owner.accessToken))
          .expect(200),
      );
      expect(list.invites.map((i) => i.id)).not.toContain(created.id);
    });

    it('an UNKNOWN token is a 404, never a 409 - no existence oracle', async () => {
      // The line that matters: a guessed token learns nothing. Only someone
      // already holding a real one is told why it will not work.
      await request(server())
        .post('/api/auth/invites/accept')
        .send({ token: 'not-a-real-token', password: PASSWORD })
        .expect(404);
      await request(server())
        .get('/api/auth/invites/token/not-a-real-token')
        .expect(404);
    });

    it('refuses a second live invite for the same email', async () => {
      const owner = await registerTenant('Invite Dupe');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Dupe');
      const email = `invitee+${randomUUID()}@test.dev`;
      const send = () =>
        request(server())
          .post('/api/auth/invites')
          .set(auth(owner.accessToken))
          .send({ email, propertyIds: [propertyId] });
      await send().expect(201);
      const second = await send().expect(409);
      expect(bodyOf<ConflictBody>(second)).toMatchObject({
        code: 'invite_already_pending',
      });
    });

    it('a failed email leaves NO pending invite blocking a retry', async () => {
      // The invite is useless without its email, and a dead-but-pending row would
      // trip `staff_invite_live_email_uniq` on every retry for that address.
      const owner = await registerTenant('Invite Mail Fail');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Mail');
      const email = `invitee+${randomUUID()}@test.dev`;
      mailerFails = true;
      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({ email, propertyIds: [propertyId] })
        .expect(503);

      const list = bodyOf<ListInvitesResponse>(
        await request(server())
          .get('/api/auth/invites')
          .set(auth(owner.accessToken))
          .expect(200),
      );
      expect(list.invites).toHaveLength(0);

      mailerFails = false;
      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({ email, propertyIds: [propertyId] })
        .expect(201);
    });

    it('INVITES an address that already has an account at another tenant (#154)', async () => {
      // The #154 fix, and the exact inverse of what M5 shipped. `app_user.email`
      // is still global, but an account is no longer welded to one Tenant - so
      // an existing account elsewhere is a person to seat, not a dead end.
      const other = await registerTenant('Invite Foreign Account');
      const owner = await registerTenant('Invite Global Email');
      const { propertyId } = await seedProperty(
        owner.tenant.id,
        'Villa Global',
      );
      const before = sent.length;

      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({ email: other.email, propertyIds: [propertyId] })
        .expect(201);
      // The email IS sent now - the whole point is that this link can work.
      expect(sent.length).toBe(before + 1);
      const invites = await dbs.db
        .select({ id: staffInvite.id })
        .from(staffInvite)
        .where(eq(staffInvite.tenantId, owner.tenant.id));
      expect(invites).toHaveLength(1);
    });

    it('still refuses an address already on THIS team', async () => {
      // The one refusal that survives #154, and the honest one: they are already
      // here. Asked of `membership`, not of `app_user`.
      const owner = await registerTenant('Invite Own Member');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Own');
      const before = sent.length;

      const res = await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({ email: owner.email, propertyIds: [propertyId] })
        .expect(409);
      expect(bodyOf<ConflictBody>(res)).toMatchObject({ code: 'email_taken' });
      // Nothing was created, and - the part that matters - nothing was sent.
      expect(sent).toHaveLength(before);
      const invites = await dbs.db
        .select({ id: staffInvite.id })
        .from(staffInvite)
        .where(eq(staffInvite.tenantId, owner.tenant.id));
      expect(invites).toHaveLength(0);
    });

    it('an EXPIRED invite does not block re-inviting the same address', async () => {
      // Also found in review. `staff_invite_live_email_uniq` cannot include
      // `expires_at > now()` (an index predicate must be immutable), so a lapsed
      // invite kept occupying the one live slot for its address: re-inviting
      // returned 409 invite_already_pending forever, and the owner had to guess
      // that revoking a dead invite was the way out.
      const owner = await registerTenant('Invite Expiry Reuse');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Again');
      const email = `invitee+${randomUUID()}@test.dev`;
      const first = bodyOf<InviteDto>(
        await request(server())
          .post('/api/auth/invites')
          .set(auth(owner.accessToken))
          .send({ email, propertyIds: [propertyId] })
          .expect(201),
      );
      await dbs.db
        .update(staffInvite)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(staffInvite.id, first.id));

      // A dead invite is not pending - it should not be on the owner's list...
      const pending = bodyOf<ListInvitesResponse>(
        await request(server())
          .get('/api/auth/invites')
          .set(auth(owner.accessToken))
          .expect(200),
      );
      expect(pending.invites.map((i) => i.id)).not.toContain(first.id);

      // ...and it must not stand in the way of a fresh one.
      const before = sent.length;
      const second = bodyOf<InviteDto>(
        await request(server())
          .post('/api/auth/invites')
          .set(auth(owner.accessToken))
          .send({ email, propertyIds: [propertyId] })
          .expect(201),
      );
      expect(second.id).not.toBe(first.id);

      // The NEW link works; the old one still reports `expired`, not `revoked` -
      // superseding it is bookkeeping, and must not rewrite what happened to it.
      const token = tokenFromLastEmail(before);
      await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: PASSWORD })
        .expect(200);
    });

    it('a superseded invite still reports EXPIRED, not revoked', async () => {
      const owner = await registerTenant('Invite Supersede Reason');
      const { propertyId } = await seedProperty(
        owner.tenant.id,
        'Villa Reason',
      );
      const email = `invitee+${randomUUID()}@test.dev`;
      const before = sent.length;
      const first = bodyOf<InviteDto>(
        await request(server())
          .post('/api/auth/invites')
          .set(auth(owner.accessToken))
          .send({ email, propertyIds: [propertyId] })
          .expect(201),
      );
      const staleToken = tokenFromLastEmail(before);
      await dbs.db
        .update(staffInvite)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(staffInvite.id, first.id));
      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({ email, propertyIds: [propertyId] })
        .expect(201);

      const refused = await request(server())
        .post('/api/auth/invites/accept')
        .send({ token: staleToken, password: PASSWORD })
        .expect(409);
      // The holder of the stale link ran out of time; they were not withdrawn.
      expect(bodyOf<ConflictBody>(refused)).toMatchObject({
        code: 'invite_not_acceptable',
        reason: 'expired',
      });
    });

    it('the stored token is a hash, not the token itself', async () => {
      const owner = await registerTenant('Invite Hashing');
      const { propertyId } = await seedProperty(owner.tenant.id, 'Villa Hash');
      const before = sent.length;
      await request(server())
        .post('/api/auth/invites')
        .set(auth(owner.accessToken))
        .send({
          email: `invitee+${randomUUID()}@test.dev`,
          propertyIds: [propertyId],
        })
        .expect(201);
      const token = tokenFromLastEmail(before);
      const rows = await dbs.db
        .select({ hash: staffInvite.tokenHash })
        .from(staffInvite)
        .where(eq(staffInvite.tenantId, owner.tenant.id));
      // A database dump must not be a list of working invite links.
      expect(rows[0].hash).not.toBe(token);
      expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // --- AC #1: staff sees assigned properties only ----------------------------

  describe('property scoping', () => {
    it('filters every list, and 404s an unassigned property by direct id', async () => {
      const owner = await registerTenant('Scope Lists');
      const yes = await seedProperty(owner.tenant.id, 'Assigned Villa');
      const no = await seedProperty(owner.tenant.id, 'Unassigned Villa');
      const staff = await inviteAndAccept(owner.accessToken, [yes.propertyId]);

      const properties = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(staff.token))
          .expect(200),
      );
      expect(properties.map((p) => p.id)).toEqual([yes.propertyId]);

      // By direct id: the assigned one is readable, the other is a 404 - NOT a
      // 403. Within a tenant an unassigned property is simply not there.
      await request(server())
        .get(`/api/properties/${yes.propertyId}`)
        .set(auth(staff.token))
        .expect(200);
      await request(server())
        .get(`/api/properties/${no.propertyId}`)
        .set(auth(staff.token))
        .expect(404);

      // The same scope, unchanged, through three more read paths that share no
      // code with the one above - which is the point of enforcing it in RLS.
      const units = bodyOf<{ id: string }[]>(
        await request(server())
          .get('/api/units')
          .set(auth(staff.token))
          .expect(200),
      );
      expect(units.map((u) => u.id)).toEqual([yes.unitId]);

      const bookings = bodyOf<{ id: string }[]>(
        await request(server())
          .get('/api/bookings')
          .set(auth(staff.token))
          .expect(200),
      );
      expect(bookings.map((b) => b.id)).toEqual([yes.bookingId]);

      await request(server())
        .get(`/api/bookings/${no.bookingId}`)
        .set(auth(staff.token))
        .expect(404);

      // The control: the owner still sees both, so the assertions above are
      // measuring the scope and not a broken fixture.
      const asOwner = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(owner.accessToken))
          .expect(200),
      );
      expect(asOwner.map((p) => p.id).sort()).toEqual(
        [yes.propertyId, no.propertyId].sort(),
      );
    });

    it('refuses to WRITE to an unassigned property, with the same 404', async () => {
      const owner = await registerTenant('Scope Writes');
      const yes = await seedProperty(owner.tenant.id, 'Writable Villa');
      const no = await seedProperty(owner.tenant.id, 'Off-limits Villa');
      const staff = await inviteAndAccept(owner.accessToken, [yes.propertyId]);

      // Editing what they're assigned is the whole point of being staff.
      await request(server())
        .patch(`/api/properties/${yes.propertyId}`)
        .set(auth(staff.token))
        .send({ description: 'Tidied up by staff' })
        .expect(200);

      await request(server())
        .patch(`/api/properties/${no.propertyId}`)
        .set(auth(staff.token))
        .send({ description: 'Should never land' })
        .expect(404);

      const [row] = await dbs.db
        .select({ description: property.description })
        .from(property)
        .where(eq(property.id, no.propertyId));
      expect(row.description).toBeNull();
    });

    it('a cross-tenant property is a 404 for staff, exactly as for an owner', async () => {
      const a = await registerTenant('Scope Tenant A');
      const b = await registerTenant('Scope Tenant B');
      const mine = await seedProperty(a.tenant.id, 'Mine');
      const theirs = await seedProperty(b.tenant.id, 'Theirs');
      const staff = await inviteAndAccept(a.accessToken, [mine.propertyId]);

      // Both axes hold at once: tenant isolation is not weakened by the property
      // scope sitting inside it.
      await request(server())
        .get(`/api/properties/${theirs.propertyId}`)
        .set(auth(staff.token))
        .expect(404);
      await request(server())
        .get(`/api/properties/${theirs.propertyId}`)
        .set(auth(a.accessToken))
        .expect(404);
    });

    it('staff assigned to nothing they can reach see nothing - never everything', async () => {
      // Fail-closed, at the HTTP layer: if the scope ever degraded to "no
      // restriction" this would return the tenant's whole inventory.
      const owner = await registerTenant('Scope Empty');
      const one = await seedProperty(owner.tenant.id, 'Only Villa');
      const staff = await inviteAndAccept(owner.accessToken, [one.propertyId]);
      await dbs.db
        .delete(userProperty)
        .where(eq(userProperty.appUserId, staff.userId));

      const properties = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(staff.token))
          .expect(200),
      );
      expect(properties).toEqual([]);
    });
  });

  // --- AC #2: role denials are 403, not 404 ----------------------------------

  describe('owner-only routes', () => {
    let ownerToken: string;
    let staffToken: string;
    let propertyId: string;

    beforeAll(async () => {
      const owner = await registerTenant('Role Gate');
      ownerToken = owner.accessToken;
      const seeded = await seedProperty(owner.tenant.id, 'Gate Villa');
      propertyId = seeded.propertyId;
      staffToken = (await inviteAndAccept(ownerToken, [propertyId])).token;
    });

    // The table IS the decision (which verbs change the shape of the tenant),
    // written down where a reviewer can read it in one place.
    const ownerOnly: [string, () => request.Test][] = [
      [
        'PATCH /settings',
        () => request(server()).patch('/api/settings').send({ galleryCap: 12 }),
      ],
      ['GET /auth/invites', () => request(server()).get('/api/auth/invites')],
      [
        'POST /auth/invites',
        () =>
          request(server())
            .post('/api/auth/invites')
            .send({ email: 'x@test.dev', propertyIds: [propertyId] }),
      ],
      ['GET /staff', () => request(server()).get('/api/staff')],
      [
        'POST /properties',
        () => request(server()).post('/api/properties').send({ name: 'Nope' }),
      ],
      [
        'DELETE /properties/:id',
        () => request(server()).delete(`/api/properties/${propertyId}`),
      ],
      [
        'POST /properties/:id/archive',
        () => request(server()).post(`/api/properties/${propertyId}/archive`),
      ],
    ];

    for (const [label, call] of ownerOnly) {
      it(`${label}: staff gets 403 explaining the ROLE, not a 404`, async () => {
        const res = await call().set(auth(staffToken)).expect(403);
        // 403 and not the 404-over-403 convention: nothing is being hidden, so
        // "you lack the role" is the honest, actionable answer (api-spec §1).
        expect(bodyOf<{ message: string }>(res).message).toMatch(/owner/i);
      });
    }

    it('the read half of settings stays open to staff', async () => {
      // The property workbench needs the gallery cap; only the WRITE is the
      // owner's (#67). A blanket class-level role gate would have broken this.
      await request(server())
        .get('/api/settings')
        .set(auth(staffToken))
        .expect(200);
    });

    it('staff may still operate what they are assigned', async () => {
      // The other half of the line: if everything were owner-only, "staff" would
      // be a read-only account and the feature would be pointless.
      await request(server())
        .post(`/api/properties/${propertyId}/units`)
        .set(auth(staffToken))
        .send({
          name: `Staff Unit ${randomUUID()}`,
          basePriceIdr: 600_000,
          maxGuests: 2,
          minStay: 1,
        })
        .expect(201);
    });
  });

  // --- AC #4 at the HTTP layer, plus the roster ------------------------------

  describe('the team roster', () => {
    it('refuses to grant a property from another tenant', async () => {
      const a = await registerTenant('Grant Tenant A');
      const b = await registerTenant('Grant Tenant B');
      const theirs = await seedProperty(b.tenant.id, 'Not Yours');
      const res = await request(server())
        .post('/api/auth/invites')
        .set(auth(a.accessToken))
        .send({
          email: `invitee+${randomUUID()}@test.dev`,
          propertyIds: [theirs.propertyId],
        })
        .expect(404);
      // 404 and not 403: naming another tenant's property must not confirm it
      // exists. Nothing was created.
      expect(bodyOf<{ message: string }>(res).message).toMatch(/property/i);
      const invites = await dbs.db
        .select({ id: staffInvite.id })
        .from(staffInvite)
        .where(eq(staffInvite.tenantId, a.tenant.id));
      expect(invites).toHaveLength(0);
    });

    it('lists staff with their assignments, and re-assignment takes effect', async () => {
      const owner = await registerTenant('Roster Reassign');
      const first = await seedProperty(owner.tenant.id, 'First Villa');
      const second = await seedProperty(owner.tenant.id, 'Second Villa');
      const staff = await inviteAndAccept(owner.accessToken, [
        first.propertyId,
      ]);

      const roster = bodyOf<ListStaffResponse>(
        await request(server())
          .get('/api/staff')
          .set(auth(owner.accessToken))
          .expect(200),
      );
      expect(roster.staff).toHaveLength(1);
      expect(roster.staff[0].properties.map((p) => p.name)).toEqual([
        'First Villa',
      ]);

      const updated = bodyOf<StaffMemberDto>(
        await request(server())
          .patch(`/api/staff/${staff.userId}`)
          .set(auth(owner.accessToken))
          .send({ propertyIds: [second.propertyId] })
          .expect(200),
      );
      expect(updated.properties.map((p) => p.name)).toEqual(['Second Villa']);

      // A whole-set write: the old assignment is gone, not merely joined by the
      // new one - so this is how access is REMOVED, with no second verb.
      const visible = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(staff.token))
          .expect(200),
      );
      expect(visible.map((p) => p.id)).toEqual([second.propertyId]);
    });

    it('removes the SEAT, not the human, and the session stops working', async () => {
      const owner = await registerTenant('Roster Remove');
      const seeded = await seedProperty(owner.tenant.id, 'Removal Villa');
      const staff = await inviteAndAccept(owner.accessToken, [
        seeded.propertyId,
      ]);

      await request(server())
        .delete(`/api/staff/${staff.userId}`)
        .set(auth(owner.accessToken))
        .expect(204);

      // The access token is still cryptographically valid until it expires, and
      // that is the honest limit of a stateless token: the seat is gone, so every
      // scoped read now finds nothing, and no refresh can mint another.
      const properties = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(staff.token))
          .expect(200),
      );
      expect(properties).toEqual([]);

      // The ACCOUNT survives (#154) - one owner must not be able to delete a
      // login that another owner's team may also depend on. Its assignments went
      // with the seat, via the composite FK.
      const account = await dbs.db
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.id, staff.userId));
      expect(account).toHaveLength(1);
      const seats = await dbs.db
        .select({ tenantId: membership.tenantId })
        .from(membership)
        .where(eq(membership.appUserId, staff.userId));
      expect(seats).toEqual([]);
      const grants = await dbs.db
        .select({ propertyId: userProperty.propertyId })
        .from(userProperty)
        .where(eq(userProperty.appUserId, staff.userId));
      expect(grants).toEqual([]);

      // 403, not 401: the password was CORRECT, so "invalid credentials" would
      // send them to reset a password that works. Reachable only after a correct
      // password, so it is no existence oracle.
      await request(server())
        .post('/api/auth/login')
        .send({ email: staff.email, password: PASSWORD })
        .expect(403);
    });

    it("cannot remove itself, another owner, or another tenant's staff", async () => {
      const a = await registerTenant('Roster Guard A');
      const b = await registerTenant('Roster Guard B');
      const seeded = await seedProperty(b.tenant.id, 'Guarded Villa');
      const theirStaff = await inviteAndAccept(b.accessToken, [
        seeded.propertyId,
      ]);

      // Yourself: 403, and it says why. Not a 404 - you plainly exist, and
      // "that account is gone" would be a lie you could disprove by reloading.
      await request(server())
        .delete(`/api/staff/${a.user.id}`)
        .set(auth(a.accessToken))
        .expect(403);

      // A DIFFERENT owner of the same tenant: 404, because `role = 'staff'` is
      // in the WHERE - there is no staff member by that id to speak of. This is
      // the guard that stops one owner deleting another through a staff route.
      const [coOwner] = await dbs.db
        .insert(appUser)
        .values({
          email: `co-owner+${randomUUID()}@test.dev`,
          passwordHash: 'x',
        })
        .returning({ id: appUser.id });
      await dbs.db.insert(membership).values({
        appUserId: coOwner.id,
        tenantId: a.tenant.id,
        role: 'owner',
      });
      await request(server())
        .delete(`/api/staff/${coOwner.id}`)
        .set(auth(a.accessToken))
        .expect(404);
      const stillThere = await dbs.db
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.id, coOwner.id));
      expect(stillThere).toHaveLength(1);

      await request(server())
        .delete(`/api/staff/${theirStaff.userId}`)
        .set(auth(a.accessToken))
        .expect(404);
      // ...and B's staff member is untouched.
      const survivors = await dbs.db
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.id, theirStaff.userId));
      expect(survivors).toHaveLength(1);
    });

    it("one tenant's owner cannot see another tenant's invites or staff", async () => {
      const a = await registerTenant('Roster Isolation A');
      const b = await registerTenant('Roster Isolation B');
      const seeded = await seedProperty(b.tenant.id, 'B Villa');
      await inviteAndAccept(b.accessToken, [seeded.propertyId]);
      await request(server())
        .post('/api/auth/invites')
        .set(auth(b.accessToken))
        .send({
          email: `invitee+${randomUUID()}@test.dev`,
          propertyIds: [seeded.propertyId],
        })
        .expect(201);

      const staffList = bodyOf<ListStaffResponse>(
        await request(server())
          .get('/api/staff')
          .set(auth(a.accessToken))
          .expect(200),
      );
      const inviteList = bodyOf<ListInvitesResponse>(
        await request(server())
          .get('/api/auth/invites')
          .set(auth(a.accessToken))
          .expect(200),
      );
      expect(staffList.staff).toEqual([]);
      expect(inviteList.invites).toEqual([]);
    });
  });

  // --- #154: one person, two villa owners ------------------------------------

  describe('one account, two tenants (#154)', () => {
    /** Invite `email` into `ownerToken`'s tenant and return the raw token. */
    async function inviteToken(
      ownerToken: string,
      email: string,
      propertyIds: string[],
    ): Promise<string> {
      const before = sent.length;
      await request(server())
        .post('/api/auth/invites')
        .set(auth(ownerToken))
        .send({ email, propertyIds })
        .expect(201);
      return tokenFromLastEmail(before);
    }

    it('seats an existing account at a second tenant, and both seats work', async () => {
      // The scenario the issue is named after: a property manager working for
      // two villa owners, with one email address.
      const first = await registerTenant('Manager Tenant One');
      const firstProp = await seedProperty(first.tenant.id, 'Villa One');
      const manager = await inviteAndAccept(first.accessToken, [
        firstProp.propertyId,
      ]);

      const second = await registerTenant('Manager Tenant Two');
      const secondProp = await seedProperty(second.tenant.id, 'Villa Two');
      const token = await inviteToken(second.accessToken, manager.email, [
        secondProp.propertyId,
      ]);

      // The page must know which password to ask for BEFORE asking.
      const preview = bodyOf<InvitePreviewResponse>(
        await request(server())
          .get(`/api/auth/invites/token/${token}`)
          .expect(200),
      );
      expect(preview.mode).toBe('signin');

      const accepted = bodyOf<AuthResponse>(
        await request(server())
          .post('/api/auth/invites/accept')
          .send({ token, password: PASSWORD })
          .expect(200),
      );
      // One account - the same id, not a second row for the same address.
      expect(accepted.user.id).toBe(manager.userId);
      expect(accepted.tenant.id).toBe(second.tenant.id);
      expect(accepted.memberships.map((m) => m.tenantId).sort()).toEqual(
        [first.tenant.id, second.tenant.id].sort(),
      );

      // And the scope follows the ACTIVE seat, not the person: this session sees
      // tenant two's property and nothing of tenant one's.
      const inSecond = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(accepted.accessToken))
          .expect(200),
      );
      expect(inSecond.map((p) => p.id)).toEqual([secondProp.propertyId]);

      // Switch back, and the same account sees tenant one's property instead.
      const switched = bodyOf<AuthResponse>(
        await request(server())
          .post('/api/auth/session')
          .set(auth(accepted.accessToken))
          .send({ tenantId: first.tenant.id })
          .expect(200),
      );
      expect(switched.tenant.id).toBe(first.tenant.id);
      const inFirst = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(switched.accessToken))
          .expect(200),
      );
      expect(inFirst.map((p) => p.id)).toEqual([firstProp.propertyId]);
    });

    it('refuses the second seat when the existing password is wrong, and does NOT spend the invite', async () => {
      const first = await registerTenant('Wrong Password One');
      const firstProp = await seedProperty(first.tenant.id, 'WP Villa One');
      const manager = await inviteAndAccept(first.accessToken, [
        firstProp.propertyId,
      ]);

      const second = await registerTenant('Wrong Password Two');
      const secondProp = await seedProperty(second.tenant.id, 'WP Villa Two');
      const token = await inviteToken(second.accessToken, manager.email, [
        secondProp.propertyId,
      ]);

      // The invite token proves control of the mailbox; it does not prove
      // control of the ACCOUNT, and attaching a seat to someone else's login
      // needs both.
      await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: 'not-the-password' })
        .expect(401);

      // Unspent: a mistyped password must be retryable, or one slip burns a link
      // that exists in exactly one email.
      const retried = bodyOf<AuthResponse>(
        await request(server())
          .post('/api/auth/invites/accept')
          .send({ token, password: PASSWORD })
          .expect(200),
      );
      expect(retried.tenant.id).toBe(second.tenant.id);
    });

    it('says `create` for an address with no account', async () => {
      const owner = await registerTenant('Create Mode');
      const { propertyId } = await seedProperty(owner.tenant.id, 'CM Villa');
      const token = await inviteToken(
        owner.accessToken,
        `newcomer+${randomUUID()}@test.dev`,
        [propertyId],
      );
      const preview = bodyOf<InvitePreviewResponse>(
        await request(server())
          .get(`/api/auth/invites/token/${token}`)
          .expect(200),
      );
      expect(preview.mode).toBe('create');
    });

    it('one owner removing a seat leaves the other tenant untouched', async () => {
      const first = await registerTenant('Two Seats One');
      const firstProp = await seedProperty(first.tenant.id, 'TS Villa One');
      const manager = await inviteAndAccept(first.accessToken, [
        firstProp.propertyId,
      ]);

      const second = await registerTenant('Two Seats Two');
      const secondProp = await seedProperty(second.tenant.id, 'TS Villa Two');
      const token = await inviteToken(second.accessToken, manager.email, [
        secondProp.propertyId,
      ]);
      await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: PASSWORD })
        .expect(200);

      // Tenant one dismisses them. Tenant two never agreed to that.
      await request(server())
        .delete(`/api/staff/${manager.userId}`)
        .set(auth(first.accessToken))
        .expect(204);

      const login = bodyOf<AuthResponse>(
        await request(server())
          .post('/api/auth/login')
          .send({ email: manager.email, password: PASSWORD })
          .expect(200),
      );
      expect(login.memberships.map((m) => m.tenantId)).toEqual([
        second.tenant.id,
      ]);
      const visible = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(login.accessToken))
          .expect(200),
      );
      expect(visible.map((p) => p.id)).toEqual([secondProp.propertyId]);

      // ...and the seat that was removed cannot be re-entered by naming it.
      await request(server())
        .post('/api/auth/session')
        .set(auth(login.accessToken))
        .send({ tenantId: first.tenant.id })
        .expect(404);
    });

    it('a removed person can be re-invited and set a NEW password', async () => {
      // The regression #154 would otherwise introduce, found in review. Before
      // memberships, removing someone DELETED the account, so re-inviting was a
      // clean start. Now the account survives - and Sambung has no password
      // reset, so if `signin` mode were forced here, someone who forgot their
      // password could never be re-invited by anyone, ever.
      const owner = await registerTenant('Re-invite Tenant');
      const seeded = await seedProperty(owner.tenant.id, 'Reinvite Villa');
      const staff = await inviteAndAccept(owner.accessToken, [
        seeded.propertyId,
      ]);

      await request(server())
        .delete(`/api/staff/${staff.userId}`)
        .set(auth(owner.accessToken))
        .expect(204);

      const token = await inviteToken(owner.accessToken, staff.email, [
        seeded.propertyId,
      ]);
      // The account still exists but is INERT - no seats - so it is claimable.
      const preview = bodyOf<InvitePreviewResponse>(
        await request(server())
          .get(`/api/auth/invites/token/${token}`)
          .expect(200),
      );
      expect(preview.mode).toBe('create');

      const NEW_PASSWORD = 'brandnewpass9';
      const accepted = bodyOf<AuthResponse>(
        await request(server())
          .post('/api/auth/invites/accept')
          .send({ token, password: NEW_PASSWORD })
          .expect(200),
      );
      // Same account row - not a second one for the same address.
      expect(accepted.user.id).toBe(staff.userId);

      // The NEW password works at the front door, and the old one does not.
      await request(server())
        .post('/api/auth/login')
        .send({ email: staff.email, password: NEW_PASSWORD })
        .expect(200);
      await request(server())
        .post('/api/auth/login')
        .send({ email: staff.email, password: PASSWORD })
        .expect(401);
    });

    it('will NOT let an invite claim a LIVE account without its password', async () => {
      // The other half of the same rule: claiming is for inert accounts only.
      // A live one must prove itself, or an invite to a known address would be a
      // password reset anyone who reads that mailbox could perform.
      const first = await registerTenant('Live Claim One');
      const firstProp = await seedProperty(first.tenant.id, 'LC Villa One');
      const manager = await inviteAndAccept(first.accessToken, [
        firstProp.propertyId,
      ]);

      const second = await registerTenant('Live Claim Two');
      const secondProp = await seedProperty(second.tenant.id, 'LC Villa Two');
      const token = await inviteToken(second.accessToken, manager.email, [
        secondProp.propertyId,
      ]);

      expect(
        bodyOf<InvitePreviewResponse>(
          await request(server())
            .get(`/api/auth/invites/token/${token}`)
            .expect(200),
        ).mode,
      ).toBe('signin');

      await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: 'a-different-password' })
        .expect(401);

      // The original password still works - nothing was overwritten.
      await request(server())
        .post('/api/auth/login')
        .send({ email: manager.email, password: PASSWORD })
        .expect(200);
    });

    it('orders tied seats totally, so the default workspace is not heap order', async () => {
      // Seats created in ONE transaction share `created_at` to the microsecond,
      // because now() is transaction-stable - which is exactly what the seed's
      // dual-seat account looks like. Without a third, TOTAL sort key the order
      // is whatever the heap returns, so "which workspace do I land in?" would be
      // arbitrary on the very login the demo leans on.
      //
      // Asserting the whole ORDER rather than just "it was stable across N
      // logins": a stable-but-wrong plan passes the latter every time. Three
      // seats make an accidental match unlikely (1 in 6) instead of a coin flip.
      const first = await registerTenant('Tie Break One');
      const firstProp = await seedProperty(first.tenant.id, 'TB Villa One');
      const manager = await inviteAndAccept(first.accessToken, [
        firstProp.propertyId,
      ]);
      for (const name of ['Tie Break Two', 'Tie Break Three']) {
        const other = await registerTenant(name);
        const prop = await seedProperty(other.tenant.id, `${name} Villa`);
        const token = await inviteToken(other.accessToken, manager.email, [
          prop.propertyId,
        ]);
        await request(server())
          .post('/api/auth/invites/accept')
          .send({ token, password: PASSWORD })
          .expect(200);
      }

      // Force the tie the seed produces naturally, then force the heap into the
      // WORST order for us. Re-inserting descending is what makes this test a
      // real discriminator rather than a coin flip: with a non-total ORDER BY,
      // Postgres returns these in scan order, so the answer would come back
      // exactly reversed. (Measured: without the tiebreaker, and without this
      // step, the assertion passed by luck.)
      const seats = await dbs.db
        .select({ tenantId: membership.tenantId, role: membership.role })
        .from(membership)
        .where(eq(membership.appUserId, manager.userId));
      await dbs.db
        .delete(membership)
        .where(eq(membership.appUserId, manager.userId));
      const tied = new Date('2026-01-01T00:00:00.000Z');
      for (const seat of [...seats].sort((a, b) =>
        b.tenantId.localeCompare(a.tenantId),
      )) {
        await dbs.db
          .insert(membership)
          .values({ ...seat, appUserId: manager.userId, createdAt: tied });
      }

      const login = bodyOf<AuthResponse>(
        await request(server())
          .post('/api/auth/login')
          .send({ email: manager.email, password: PASSWORD })
          .expect(200),
      );
      const seen = login.memberships.map((m) => m.tenantId);
      expect(seen).toHaveLength(3);
      // All three are staff seats with identical timestamps, so tenantId - the
      // documented tiebreaker - is the whole of the order.
      expect(seen).toEqual([...seen].sort());
      // ...and the default is the head of that list, not a separate rule.
      expect(login.tenant.id).toBe(seen[0]);
    });

    it('a staff member of two tenants appears on each roster once', async () => {
      const first = await registerTenant('Roster Split One');
      const firstProp = await seedProperty(first.tenant.id, 'RS Villa One');
      const manager = await inviteAndAccept(first.accessToken, [
        firstProp.propertyId,
      ]);

      const second = await registerTenant('Roster Split Two');
      const secondProp = await seedProperty(second.tenant.id, 'RS Villa Two');
      const token = await inviteToken(second.accessToken, manager.email, [
        secondProp.propertyId,
      ]);
      await request(server())
        .post('/api/auth/invites/accept')
        .send({ token, password: PASSWORD })
        .expect(200);

      // Each owner sees their own team, with their own Assignments - never the
      // other tenant's grant leaking through a shared account row.
      for (const [owner, expected] of [
        [first, firstProp.propertyId],
        [second, secondProp.propertyId],
      ] as const) {
        const roster = bodyOf<ListStaffResponse>(
          await request(server())
            .get('/api/staff')
            .set(auth(owner.accessToken))
            .expect(200),
        );
        const row = roster.staff.filter((s) => s.id === manager.userId);
        expect(row).toHaveLength(1);
        expect(row[0].properties.map((p) => p.id)).toEqual([expected]);
      }
    });
  });
});
