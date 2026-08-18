import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import {
  appUser,
  channelConnection,
  membership,
  tenant,
  userProperty,
} from '@sambung/db';
import {
  syncHealthResponseSchema,
  type AuthResponse,
  type ChannelConnectionResponse,
  type PropertyResponse,
  type SyncHealthResponse,
  type UnitResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { SYNC_STALE_AFTER_MINUTES } from './channel-sync.constants';
import { FakeIcalFetcher } from './fake-ical-fetcher';
import { ICAL_FETCHER } from './ical-fetcher';

/**
 * Sync freshness + the fleet health read (api-spec §7.2/§7.7, REQ-AV-04, spec
 * docs/spec/honesty-sync-ux.md) over real HTTP + real Postgres.
 *
 * Every feed here is connected through the real endpoint and then AGED with a
 * direct UPDATE, because the one thing this feature reports - "nothing has pulled
 * this for a while" - takes hours to reach honestly and is the whole subject.
 */
describe('Sync freshness (REQ-AV-04)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const fake = new FakeIcalFetcher();
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const PASSWORD = 'supersecret1';

  async function registerTenant(
    label: string,
  ): Promise<AuthResponse & { email: string }> {
    const email = `${label}+${randomUUID()}@test.dev`;
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: `${label} ${randomUUID()}`,
        email,
        password: PASSWORD,
      })
      .expect(201);
    const session = bodyOf<AuthResponse>(res);
    createdTenantIds.push(session.tenant.id);
    return { ...session, email };
  }

  async function createProperty(token: string): Promise<PropertyResponse> {
    return bodyOf<PropertyResponse>(
      await request(server())
        .post('/api/properties')
        .set(auth(token))
        .send({ name: `Health Villa ${randomUUID()}` })
        .expect(201),
    );
  }

  async function createUnit(
    token: string,
    propertyId: string,
  ): Promise<UnitResponse> {
    return bodyOf<UnitResponse>(
      await request(server())
        .post(`/api/properties/${propertyId}/units`)
        .set(auth(token))
        .send({ name: `Room ${randomUUID()}`, basePriceIdr: 1_000_000 })
        .expect(201),
    );
  }

  /** A connected feed, through the real route (so `last_synced_at` is stamped the
   * way production stamps it). */
  async function connectFeed(
    token: string,
    unitId: string,
    channel: 'airbnb' | 'booking_com' | 'vrbo' = 'airbnb',
  ): Promise<ChannelConnectionResponse> {
    return bodyOf<ChannelConnectionResponse>(
      await request(server())
        .post(`/api/units/${unitId}/channels`)
        .set(auth(token))
        .send({
          channel,
          importIcalUrl: `https://ota.example.com/${randomUUID()}.ics`,
        })
        .expect(201),
    );
  }

  /** Push a feed's last good pull N minutes into the past. */
  async function age(connectionId: string, minutes: number): Promise<void> {
    await dbs.db
      .update(channelConnection)
      .set({ lastSyncedAt: new Date(Date.now() - minutes * 60_000) })
      .where(eq(channelConnection.id, connectionId));
  }

  const listFeeds = (token: string, unitId: string) =>
    request(server()).get(`/api/units/${unitId}/channels`).set(auth(token));

  const getHealth = async (token: string): Promise<SyncHealthResponse> => {
    const res = await request(server())
      .get('/api/channels/health')
      .set(auth(token))
      .expect(200);
    return syncHealthResponseSchema.parse(bodyOf(res));
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ICAL_FETCHER)
      .useValue(fake)
      .compile();
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

  beforeEach(() => {
    fake.calls.length = 0;
    fake.nextResult = { ok: true, error: null };
  });

  // --- Per-feed staleness (spec §1, FR-01/04/05/06) -------------------------

  describe('a feed carries its own staleness (§7.2)', () => {
    it('flips exactly at the threshold, not near it', async () => {
      const owner = await registerTenant('stale-edge');
      const unit = await createUnit(
        owner.accessToken,
        (await createProperty(owner.accessToken)).id,
      );
      const feed = await connectFeed(owner.accessToken, unit.id);

      // One minute inside the line: fresh.
      await age(feed.id, SYNC_STALE_AFTER_MINUTES - 1);
      const fresh = bodyOf<ChannelConnectionResponse[]>(
        await listFeeds(owner.accessToken, unit.id).expect(200),
      );
      expect(fresh[0].stale).toBe(false);

      // One minute past it: stale. Same row, same request, nothing else changed.
      await age(feed.id, SYNC_STALE_AFTER_MINUTES + 1);
      const old = bodyOf<ChannelConnectionResponse[]>(
        await listFeeds(owner.accessToken, unit.id).expect(200),
      );
      expect(old[0].stale).toBe(true);
      // Staleness never touches the stored health - it is derived, not a column.
      expect(old[0].lastStatus).toBe('ok');
    });

    it('does not call a never-synced feed stale', async () => {
      const owner = await registerTenant('stale-never');
      const unit = await createUnit(
        owner.accessToken,
        (await createProperty(owner.accessToken)).id,
      );
      // A feed that failed its smoke fetch has never synced: last_synced_at null.
      fake.nextResult = { ok: false, error: 'Feed is unreachable' };
      const feed = await connectFeed(owner.accessToken, unit.id);
      expect(feed.lastSyncedAt).toBeNull();

      // "Never checked" is not "checked, long ago" - the owner's next action
      // differs, so the two must not collapse into one warning.
      expect(feed.stale).toBe(false);
    });

    it('reports a feed that is BOTH erroring and long out of date', async () => {
      const owner = await registerTenant('stale-error');
      const unit = await createUnit(
        owner.accessToken,
        (await createProperty(owner.accessToken)).id,
      );
      const feed = await connectFeed(owner.accessToken, unit.id);

      // It synced once, then started failing three days ago and stayed old.
      await age(feed.id, 3 * 24 * 60);
      await dbs.db
        .update(channelConnection)
        .set({ lastStatus: 'error', lastError: 'Feed is unreachable' })
        .where(eq(channelConnection.id, feed.id));

      const [row] = bodyOf<ChannelConnectionResponse[]>(
        await listFeeds(owner.accessToken, unit.id).expect(200),
      );
      expect(row.lastStatus).toBe('error');
      expect(row.stale).toBe(true);
    });
  });

  // --- The fleet read (spec §2, FL-01..06) ----------------------------------

  describe('GET /channels/health', () => {
    it('answers zeros - not a false "synced" - when nothing is connected', async () => {
      const owner = await registerTenant('health-empty');
      await expect(getHealth(owner.accessToken)).resolves.toEqual({
        feeds: 0,
        erroring: 0,
        stale: 0,
        neverSynced: 0,
        oldestSyncedAt: null,
      });
    });

    it('reports the OLDEST successful pull, not the newest (ADR-0040)', async () => {
      const owner = await registerTenant('health-oldest');
      const property = await createProperty(owner.accessToken);
      const unit = await createUnit(owner.accessToken, property.id);

      const recent = await connectFeed(owner.accessToken, unit.id, 'airbnb');
      const middling = await connectFeed(
        owner.accessToken,
        unit.id,
        'booking_com',
      );
      const ancient = await connectFeed(owner.accessToken, unit.id, 'vrbo');
      await age(recent.id, 2);
      await age(middling.id, 30);
      await age(ancient.id, 6 * 60);

      const health = await getHealth(owner.accessToken);
      expect(health.feeds).toBe(3);
      expect(health.stale).toBe(1); // only the 6-hour one is past 90 minutes
      expect(health.erroring).toBe(0);
      expect(health.neverSynced).toBe(0);

      // The fleet is as current as its stalest feed: ~6 hours, never the 2 minutes
      // the freshest feed could have claimed.
      const ageMinutes =
        (Date.now() - new Date(health.oldestSyncedAt as string).getTime()) /
        60_000;
      expect(ageMinutes).toBeGreaterThan(5 * 60);
    });

    it('withholds a freshness claim while any feed has never synced', async () => {
      const owner = await registerTenant('health-never');
      const unit = await createUnit(
        owner.accessToken,
        (await createProperty(owner.accessToken)).id,
      );

      const good = await connectFeed(owner.accessToken, unit.id, 'airbnb');
      await age(good.id, 5);
      fake.nextResult = { ok: false, error: 'Feed is unreachable' };
      await connectFeed(owner.accessToken, unit.id, 'vrbo');

      const health = await getHealth(owner.accessToken);
      expect(health.feeds).toBe(2);
      expect(health.neverSynced).toBe(1);
      expect(health.erroring).toBe(1);
      // "Checked 5 minutes ago" would be a claim about half the fleet.
      expect(health.oldestSyncedAt).toBeNull();
    });

    it('counts a genuinely mixed fleet, and counts one feed on both axes', async () => {
      const owner = await registerTenant('health-mixed');
      const unit = await createUnit(
        owner.accessToken,
        (await createProperty(owner.accessToken)).id,
      );

      // Fresh: pulled minutes ago.
      const fresh = await connectFeed(owner.accessToken, unit.id, 'airbnb');
      await age(fresh.id, 5);

      // Erroring AND stale - the fleet-level analogue of FR-05. It last worked
      // three days ago and has been failing since, so it must be counted in BOTH
      // columns; counting it once would understate one of the two problems.
      const broken = await connectFeed(
        owner.accessToken,
        unit.id,
        'booking_com',
      );
      await age(broken.id, 3 * 24 * 60);
      await dbs.db
        .update(channelConnection)
        .set({ lastStatus: 'error', lastError: 'Feed is unreachable' })
        .where(eq(channelConnection.id, broken.id));

      // Never synced: its smoke fetch failed on connect.
      fake.nextResult = { ok: false, error: 'Feed is unreachable' };
      await connectFeed(owner.accessToken, unit.id, 'vrbo');

      const health = await getHealth(owner.accessToken);
      expect(health).toEqual({
        feeds: 3,
        erroring: 2, // the stale one AND the never-synced one
        stale: 1, // the same feed the erroring count already includes
        neverSynced: 1,
        oldestSyncedAt: null, // withheld while any feed has never synced
      });
    });

    it('refuses an unauthenticated caller', async () => {
      // Tenant scope is derived from the token; without one there is no tenant to
      // scope to, and the honest answer is 401 rather than an empty fleet that
      // would read as "you have no feeds".
      await request(server()).get('/api/channels/health').expect(401);
    });

    it('withholds the age when part of the fleet has never synced, even mid-failure', async () => {
      const owner = await registerTenant('health-partial');
      const unit = await createUnit(
        owner.accessToken,
        (await createProperty(owner.accessToken)).id,
      );

      // One feed HAS a good pull to report...
      const synced = await connectFeed(owner.accessToken, unit.id, 'airbnb');
      await age(synced.id, 40);
      // ...and one has never managed one.
      fake.nextResult = { ok: false, error: 'Feed is unreachable' };
      await connectFeed(owner.accessToken, unit.id, 'vrbo');

      const health = await getHealth(owner.accessToken);
      // FL-03 wins over UX-03a here, deliberately: an age DOES exist, but it
      // describes half the fleet, and "checked 40 minutes ago" would be a claim
      // about a calendar that is partly unknown. Reporting less is the honest
      // move - the counts still say what is wrong.
      expect(health).toMatchObject({
        feeds: 2,
        erroring: 1,
        neverSynced: 1,
        oldestSyncedAt: null,
      });
    });

    it('reads stored state only - it never pulls an OTA', async () => {
      const owner = await registerTenant('health-cheap');
      const unit = await createUnit(
        owner.accessToken,
        (await createProperty(owner.accessToken)).id,
      );
      await connectFeed(owner.accessToken, unit.id);

      fake.calls.length = 0;
      await getHealth(owner.accessToken);
      // The calendar polls this while a tab is open; an outbound fetch per read
      // would point a DoS handle at our own IP.
      expect(fake.calls).toEqual([]);
    });
  });

  // --- Isolation (spec §4, ISO-01 / FL-05) ----------------------------------

  describe('isolation', () => {
    it('never counts another tenant’s feeds', async () => {
      const a = await registerTenant('health-iso-a');
      const b = await registerTenant('health-iso-b');

      const unitA = await createUnit(
        a.accessToken,
        (await createProperty(a.accessToken)).id,
      );
      const feedA = await connectFeed(a.accessToken, unitA.id);
      await age(feedA.id, 5);

      // B holds a deliberately ancient feed: if anything bled, A would go stale.
      const unitB = await createUnit(
        b.accessToken,
        (await createProperty(b.accessToken)).id,
      );
      const feedB = await connectFeed(b.accessToken, unitB.id);
      await age(feedB.id, 30 * 24 * 60);

      const health = await getHealth(a.accessToken);
      expect(health).toMatchObject({
        feeds: 1,
        stale: 0,
        erroring: 0,
        neverSynced: 0,
      });
    });

    it('counts only a staff member’s assigned properties (ADR-0032)', async () => {
      const owner = await registerTenant('health-staff');
      const assigned = await createProperty(owner.accessToken);
      const unassigned = await createProperty(owner.accessToken);

      const feedSeen = await connectFeed(
        owner.accessToken,
        (await createUnit(owner.accessToken, assigned.id)).id,
      );
      const feedHidden = await connectFeed(
        owner.accessToken,
        (await createUnit(owner.accessToken, unassigned.id)).id,
      );
      await age(feedSeen.id, 5);
      await age(feedHidden.id, 30 * 24 * 60);

      // Demote to staff and assign ONE property. The role travels the real path
      // (row -> login -> token -> guard); the assignment is the fixture.
      const [user] = await dbs.db
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.email, owner.email));
      await dbs.db
        .update(membership)
        .set({ role: 'staff' })
        .where(eq(membership.appUserId, user.id));
      await dbs.db.insert(userProperty).values({
        appUserId: user.id,
        propertyId: assigned.id,
        tenantId: owner.tenant.id,
      });
      const staffSession = bodyOf<AuthResponse>(
        await request(server())
          .post('/api/auth/login')
          .send({ email: owner.email, password: PASSWORD })
          .expect(200),
      );
      expect(staffSession.user.role).toBe('staff');

      // One feed, fresh. The month-old feed under the unassigned property does not
      // exist for this caller - and RLS, not route code, is what decided that.
      const health = await getHealth(staffSession.accessToken);
      expect(health).toMatchObject({ feeds: 1, stale: 0 });
      expect(health.oldestSyncedAt).not.toBeNull();

      // And the hidden feed is genuinely hidden, not merely uncounted.
      const rows = await dbs.db
        .select({ id: channelConnection.id })
        .from(channelConnection)
        .where(
          and(
            eq(channelConnection.id, feedHidden.id),
            eq(channelConnection.tenantId, owner.tenant.id),
          ),
        );
      expect(rows).toHaveLength(1); // it exists...
      await request(server())
        .get(`/api/units/${feedHidden.unitId}/channels`)
        .set(auth(staffSession.accessToken))
        .expect(404); // ...but not for this staff member
    });
  });
});
