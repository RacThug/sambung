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

    it('removes a staff account, and the session stops working', async () => {
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
      // that is the honest limit of a stateless token: the user is gone, so every
      // scoped read now finds nothing, and no refresh can mint another.
      const properties = bodyOf<PropertyResponse[]>(
        await request(server())
          .get('/api/properties')
          .set(auth(staff.token))
          .expect(200),
      );
      expect(properties).toEqual([]);
      await request(server())
        .post('/api/auth/login')
        .send({ email: staff.email, password: PASSWORD })
        .expect(401);
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
          tenantId: a.tenant.id,
          email: `co-owner+${randomUUID()}@test.dev`,
          passwordHash: 'x',
          role: 'owner',
        })
        .returning({ id: appUser.id });
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
});
