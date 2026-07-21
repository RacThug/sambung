import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { booking, syncConflict, syncConflictStatus, tenant } from '@sambung/db';
import {
  syncConflictStatusSchema,
  type AuthResponse,
  type ChannelConnectionResponse,
  type DismissSyncConflictResponse,
  type PropertyResponse,
  type SyncConflict,
  type SyncConnectionResponse,
  type UnitResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { FakeIcalFetcher } from './fake-ical-fetcher';
import { ICAL_FETCHER } from './ical-fetcher';
import { buildCalendar } from './ical';

/**
 * The sync-conflict inbox (#38, boss fight #3, ADR-0027) over real HTTP + real
 * Postgres, with the outbound feed faked at the ICAL_FETCHER port (api-spec §8.5) so
 * no suite hits the network.
 *
 * The conflicts under test are REAL ones: each is produced by staging a feed whose
 * VEVENT genuinely overlaps a booking the exclusion constraint is holding, then
 * letting the import refuse it. Nothing here inserts a `sync_conflict` row by hand -
 * a test that fabricated the row would prove the inbox renders, not that the pipeline
 * detects.
 */
describe('sync-conflict inbox (#38)', () => {
  let app: INestApplication;
  let dbs: DbService;
  const fake = new FakeIcalFetcher();
  const createdTenantIds: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  const daysFromToday = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  let tokenA: string;
  let tenantAId: string;
  let tokenB: string;

  async function registerTenant(label: string): Promise<AuthResponse> {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: `${label} ${randomUUID()}`,
        email: `${label}+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      })
      .expect(201);
    return bodyOf<AuthResponse>(res);
  }

  /** A fresh property + unit + connection with a UNIQUE feed url, so every test's
   * conflicts are its own (they are keyed by connection). */
  async function connectUnit(token = tokenA): Promise<{
    propertyId: string;
    unitId: string;
    connId: string;
    feedUrl: string;
  }> {
    const prop = bodyOf<PropertyResponse>(
      await request(server())
        .post('/api/properties')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Conflict Villa' })
        .expect(201),
    );
    const unit = bodyOf<UnitResponse>(
      await request(server())
        .post(`/api/properties/${prop.id}/units`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Room ${randomUUID()}`, basePriceIdr: 1_000_000 })
        .expect(201),
    );
    const feedUrl = `https://airbnb.com/ical/${randomUUID()}.ics`;
    const conn = bodyOf<ChannelConnectionResponse>(
      await request(server())
        .post(`/api/units/${unit.id}/channels`)
        .set('Authorization', `Bearer ${token}`)
        .send({ channel: 'airbnb', importIcalUrl: feedUrl })
        .expect(201),
    );
    return {
      propertyId: prop.id,
      unitId: unit.id,
      connId: conn.id,
      feedUrl,
    };
  }

  const feedWith = (events: { uid: string; start: string; end: string }[]) =>
    buildCalendar({ prodId: '-//Test OTA//EN', events });

  const syncNow = (connId: string, token = tokenA) =>
    request(server())
      .post(`/api/channels/${connId}/sync`)
      .set('Authorization', `Bearer ${token}`);

  const listConflicts = (
    token = tokenA,
    query: Record<string, string> = {},
  ): Promise<SyncConflict[]> =>
    request(server())
      .get('/api/sync-conflicts')
      .query(query)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .then((res) => bodyOf<SyncConflict[]>(res));

  const dismiss = (id: string, token = tokenA) =>
    request(server())
      .post(`/api/sync-conflicts/${id}/dismiss`)
      .set('Authorization', `Bearer ${token}`);

  /** Occupy nights with a confirmed direct booking, so a VEVENT over the same
   * nights is a genuine double-sell the exclusion constraint refuses. */
  async function occupy(
    unitId: string,
    checkIn: string,
    checkOut: string,
    guestName = 'Direct guest',
  ): Promise<string> {
    const [row] = await dbs.db
      .insert(booking)
      .values({
        tenantId: tenantAId,
        unitId,
        source: 'direct',
        status: 'confirmed',
        checkIn,
        checkOut,
        guestName,
      })
      .returning({ id: booking.id });
    return row.id;
  }

  const conflictRows = (connId: string) =>
    dbs.db
      .select()
      .from(syncConflict)
      .where(eq(syncConflict.channelConnectionId, connId));

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

    const a = await registerTenant('conf-a');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    createdTenantIds.push(a.tenant.id);

    const b = await registerTenant('conf-b');
    tokenB = b.accessToken;
    createdTenantIds.push(b.tenant.id);
  });

  afterAll(async () => {
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
  });

  beforeEach(() => fake.reset());

  // --- AC1: the conflict is recorded, the cycle completes, nothing is harmed ----

  it('records a conflict, imports the rest, leaves the blocking booking untouched', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const takenStart = daysFromToday(200);
    const takenEnd = daysFromToday(203);
    const blockingId = await occupy(unitId, takenStart, takenEnd);

    const freeStart = daysFromToday(210);
    const freeEnd = daysFromToday(212);
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'double-sold', start: takenStart, end: takenEnd },
        { uid: 'clean', start: freeStart, end: freeEnd },
      ]),
    );

    // The cycle completes: healthy status, the non-conflicting event imported, and
    // the conflict reported separately rather than as a failure.
    const summary = bodyOf<SyncConnectionResponse>(
      await syncNow(connId).expect(200),
    );
    expect(summary).toMatchObject({
      lastStatus: 'ok',
      imported: 1,
      conflicts: 1,
    });

    // The conflict row exists, open, describing the refused stay.
    const rows = await conflictRows(connId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'open',
      externalUid: 'double-sold',
      checkIn: takenStart,
      checkOut: takenEnd,
      unitId,
      tenantId: tenantAId,
      closedAt: null,
    });

    // The blocking booking is untouched - never overwritten, never auto-cancelled.
    const [blocking] = await dbs.db
      .select()
      .from(booking)
      .where(eq(booking.id, blockingId));
    expect(blocking).toMatchObject({
      status: 'confirmed',
      source: 'direct',
      checkIn: takenStart,
      checkOut: takenEnd,
    });

    // The double-sold VEVENT produced NO booking; only the clean one landed.
    const imported = await dbs.db
      .select()
      .from(booking)
      .where(eq(booking.channelConnectionId, connId));
    expect(imported).toHaveLength(1);
    expect(imported[0].externalUid).toBe('clean');
  });

  // --- AC1 (surface): the inbox names the conflict AND what is in the way -------

  it('lists the conflict with its inventory names and the blocking booking', async () => {
    const { propertyId, unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(220);
    const end = daysFromToday(223);
    const blockingId = await occupy(unitId, start, end, 'Wayan');
    fake.setFeed(feedUrl, feedWith([{ uid: 'clash', start, end }]));
    await syncNow(connId).expect(200);

    const [item] = (await listConflicts()).filter((c) => c.unitId === unitId);
    expect(item).toMatchObject({
      propertyId,
      propertyName: 'Conflict Villa',
      unitId,
      channel: 'airbnb',
      externalUid: 'clash',
      status: 'open',
      stay: { from: start, to: end },
      closedAt: null,
    });
    expect(item.firstDetectedAt).toEqual(expect.any(String));

    // The derived blocking booking - the row api-spec §7.5 says to go cancel. This
    // is what turns the inbox from a notification into an action.
    expect(item.blockingBookings).toHaveLength(1);
    expect(item.blockingBookings[0]).toMatchObject({
      id: blockingId,
      source: 'direct',
      status: 'confirmed',
      guestName: 'Wayan',
    });
  });

  // --- AC2: re-polling does not duplicate ---------------------------------------

  it('re-polling the same conflicting feed updates one row, never duplicates', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(230);
    const end = daysFromToday(233);
    await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'repeat', start, end }]));

    await syncNow(connId).expect(200);
    const [first] = await conflictRows(connId);

    await syncNow(connId).expect(200);
    await syncNow(connId).expect(200);

    const rows = await conflictRows(connId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].status).toBe('open');
    // "Since when" survives a re-detection; "last seen" moves with it.
    expect(rows[0].firstDetectedAt).toEqual(first.firstDetectedAt);
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      first.lastSeenAt.getTime(),
    );
  });

  it('tracks a moved stay on re-detection (the OTA shifted the double-sold dates)', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(240);
    const end = daysFromToday(244);
    // One long direct booking, so both the original and the shifted VEVENT clash.
    await occupy(unitId, start, end);
    fake.setFeed(
      feedUrl,
      feedWith([{ uid: 'moves', start, end: daysFromToday(242) }]),
    );
    await syncNow(connId).expect(200);

    const shifted = daysFromToday(241);
    fake.setFeed(feedUrl, feedWith([{ uid: 'moves', start: shifted, end }]));
    await syncNow(connId).expect(200);

    const rows = await conflictRows(connId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checkIn: shifted, checkOut: end });
  });

  // --- AC3: cancel the blocker, the next sync imports it and closes the conflict -

  it('closes the conflict and imports the event once the blocking booking is cancelled', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(250);
    const end = daysFromToday(253);
    const blockingId = await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'heals', start, end }]));

    await syncNow(connId).expect(200);
    expect((await conflictRows(connId))[0].status).toBe('open');

    // The owner picks the loser in the real world and cancels that side here - the
    // ONLY resolution path (there is no "mark resolved" endpoint, api-spec §7.5).
    await request(server())
      .post(`/api/bookings/${blockingId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    const summary = bodyOf<SyncConnectionResponse>(
      await syncNow(connId).expect(200),
    );
    expect(summary).toMatchObject({ imported: 1, conflicts: 0 });

    // The event is now a real booking...
    const imported = await dbs.db
      .select()
      .from(booking)
      .where(eq(booking.channelConnectionId, connId));
    expect(imported).toHaveLength(1);
    expect(imported[0].externalUid).toBe('heals');

    // ...and the conflict closed itself, with a timestamp.
    const [conflict] = await conflictRows(connId);
    expect(conflict.status).toBe('resolved');
    expect(conflict.closedAt).not.toBeNull();

    // It has left the inbox (the default list is `open`).
    const open = await listConflicts();
    expect(open.map((c) => c.id)).not.toContain(conflict.id);
    // ...but it is still readable as history.
    const resolved = await listConflicts(tokenA, { status: 'resolved' });
    expect(resolved.map((c) => c.id)).toContain(conflict.id);
  });

  it('closes the conflict when the OTA withdraws the double-sold event', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(260);
    const end = daysFromToday(263);
    await occupy(unitId, start, end);
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'withdrawn', start, end },
        // A second, clean event: the absent-UID rules only run on a feed that still
        // carries >= 1 event, so this is what keeps the feed non-empty after the
        // conflicting UID disappears.
        { uid: 'keeper', start: daysFromToday(270), end: daysFromToday(272) },
      ]),
    );
    await syncNow(connId).expect(200);
    expect((await conflictRows(connId))[0].status).toBe('open');

    // The OTA cancelled its side: the UID is simply gone from the next pull.
    fake.setFeed(
      feedUrl,
      feedWith([
        { uid: 'keeper', start: daysFromToday(270), end: daysFromToday(272) },
      ]),
    );
    await syncNow(connId).expect(200);

    const [conflict] = await conflictRows(connId);
    expect(conflict.status).toBe('resolved');
    expect(conflict.closedAt).not.toBeNull();
  });

  // --- The asymmetry that makes the inbox usable (ADR-0027) --------------------

  it('keeps a dismissed conflict dismissed when the feed re-offers it', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(280);
    const end = daysFromToday(283);
    await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'judged', start, end }]));
    await syncNow(connId).expect(200);

    const [item] = (await listConflicts()).filter((c) => c.unitId === unitId);
    const dismissed = bodyOf<DismissSyncConflictResponse>(
      await dismiss(item.id).expect(200),
    );
    expect(dismissed).toMatchObject({ id: item.id, status: 'dismissed' });
    expect(dismissed.closedAt).not.toBeNull();

    // The feed still double-sells, and the cron keeps running. A dismissal the cron
    // could undo would resurrect every 30 minutes until the owner stopped looking.
    await syncNow(connId).expect(200);
    await syncNow(connId).expect(200);

    const rows = await conflictRows(connId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('dismissed');
    expect(await listConflicts()).not.toContainEqual(
      expect.objectContaining({ id: item.id }),
    );
  });

  it('reopens a resolved conflict when the nights are taken again', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(290);
    const end = daysFromToday(293);
    const firstBlockerId = await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'flaps', start, end }]));
    await syncNow(connId).expect(200);

    // Heal it: cancel the blocker, sync, conflict resolves and the event imports.
    await request(server())
      .post(`/api/bookings/${firstBlockerId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    await syncNow(connId).expect(200);
    expect((await conflictRows(connId))[0].status).toBe('resolved');

    // Now break it again: cancel the imported booking (freeing the nights in
    // Sambung's eyes) and hand them to a direct guest, so the next pull of the SAME
    // still-present UID clashes anew.
    const [importedRow] = await dbs.db
      .select()
      .from(booking)
      .where(
        and(
          eq(booking.channelConnectionId, connId),
          eq(booking.externalUid, 'flaps'),
        ),
      );
    await request(server())
      .post(`/api/bookings/${importedRow.id}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    await occupy(unitId, start, end, 'Second guest');

    await syncNow(connId).expect(200);

    const [conflict] = await conflictRows(connId);
    // A measurement can be re-taken - and this one says the clash is back.
    expect(conflict.status).toBe('open');
    expect(conflict.closedAt).toBeNull();
  });

  // --- AC4: a doubtful feed changes nothing, conflicts included -----------------

  it('leaves open conflicts alone when the feed is unreachable', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(300);
    const end = daysFromToday(303);
    await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'stuck', start, end }]));
    await syncNow(connId).expect(200);
    const [before] = await conflictRows(connId);
    expect(before.status).toBe('open');

    // The feed goes down. A conflict must not be "resolved" by our inability to
    // look - closing it would tell the owner a double-sell went away when all that
    // happened is the OTA stopped answering.
    fake.setFeedError(feedUrl, 'Feed is unreachable');
    const summary = bodyOf<SyncConnectionResponse>(
      await syncNow(connId).expect(200),
    );
    expect(summary).toMatchObject({ lastStatus: 'error', conflicts: 0 });

    const [after] = await conflictRows(connId);
    expect(after.status).toBe('open');
    expect(after.closedAt).toBeNull();
  });

  it('leaves open conflicts alone when the feed is healthy but empty', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(310);
    const end = daysFromToday(313);
    await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'empty-later', start, end }]));
    await syncNow(connId).expect(200);
    expect((await conflictRows(connId))[0].status).toBe('open');

    // An empty calendar is indistinguishable from one truncated to zero (ADR-0025),
    // so it cancels no bookings - and by the same argument closes no conflicts.
    fake.setFeed(feedUrl, feedWith([]));
    const summary = bodyOf<SyncConnectionResponse>(
      await syncNow(connId).expect(200),
    );
    expect(summary).toMatchObject({ lastStatus: 'ok', cancelled: 0 });

    const [after] = await conflictRows(connId);
    expect(after.status).toBe('open');
  });

  // --- AC6: the count surfaces on the connection (the §7.2 field #55 deferred) ---

  it('reports openConflicts on the connection, and it returns to zero', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(320);
    const end = daysFromToday(323);
    const blockingId = await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'badge', start, end }]));

    const before = bodyOf<ChannelConnectionResponse[]>(
      await request(server())
        .get(`/api/units/${unitId}/channels`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200),
    );
    expect(before[0].openConflicts).toBe(0);

    await syncNow(connId).expect(200);
    const during = bodyOf<ChannelConnectionResponse[]>(
      await request(server())
        .get(`/api/units/${unitId}/channels`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200),
    );
    expect(during[0]).toMatchObject({ lastStatus: 'ok', openConflicts: 1 });

    await request(server())
      .post(`/api/bookings/${blockingId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    await syncNow(connId).expect(200);

    const after = bodyOf<ChannelConnectionResponse[]>(
      await request(server())
        .get(`/api/units/${unitId}/channels`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200),
    );
    // Resolved conflicts are history, not a badge that never clears.
    expect(after[0].openConflicts).toBe(0);
  });

  // --- Filtering -----------------------------------------------------------------

  it('filters by property', async () => {
    const one = await connectUnit();
    const two = await connectUnit();
    const start = daysFromToday(330);
    const end = daysFromToday(333);
    await occupy(one.unitId, start, end);
    await occupy(two.unitId, start, end);
    fake.setFeed(one.feedUrl, feedWith([{ uid: 'p1', start, end }]));
    fake.setFeed(two.feedUrl, feedWith([{ uid: 'p2', start, end }]));
    await syncNow(one.connId).expect(200);
    await syncNow(two.connId).expect(200);

    const scoped = await listConflicts(tokenA, { propertyId: one.propertyId });
    expect(scoped.map((c) => c.externalUid)).toContain('p1');
    expect(scoped.map((c) => c.externalUid)).not.toContain('p2');
    expect(scoped.every((c) => c.propertyId === one.propertyId)).toBe(true);
  });

  it('400s an unknown status filter rather than silently listing everything', async () => {
    await request(server())
      .get('/api/sync-conflicts')
      .query({ status: 'whatever' })
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);
  });

  // --- Tenant isolation (invariant #2) -------------------------------------------

  it('never shows or lets another tenant dismiss a conflict', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(340);
    const end = daysFromToday(343);
    await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'private', start, end }]));
    await syncNow(connId).expect(200);
    const [row] = await conflictRows(connId);

    // B cannot see it...
    const bList = await listConflicts(tokenB);
    expect(bList.map((c) => c.id)).not.toContain(row.id);
    // ...and cannot act on it. 404, not 403 - existence is never disclosed (§1).
    await dismiss(row.id, tokenB).expect(404);

    // A's row is untouched by B's attempt.
    const [after] = await conflictRows(connId);
    expect(after.status).toBe('open');
    expect(after.closedAt).toBeNull();
  });

  it('404s an unknown conflict id', async () => {
    await dismiss(randomUUID()).expect(404);
  });

  it('requires auth on both routes', async () => {
    await request(server()).get('/api/sync-conflicts').expect(401);
    await request(server())
      .post(`/api/sync-conflicts/${randomUUID()}/dismiss`)
      .expect(401);
  });

  // --- Dismiss is idempotent -----------------------------------------------------

  it('is idempotent: dismissing twice echoes the same closed state', async () => {
    const { unitId, connId, feedUrl } = await connectUnit();
    const start = daysFromToday(350);
    const end = daysFromToday(353);
    await occupy(unitId, start, end);
    fake.setFeed(feedUrl, feedWith([{ uid: 'twice', start, end }]));
    await syncNow(connId).expect(200);
    const [row] = await conflictRows(connId);

    const first = bodyOf<DismissSyncConflictResponse>(
      await dismiss(row.id).expect(200),
    );
    const second = bodyOf<DismissSyncConflictResponse>(
      await dismiss(row.id).expect(200),
    );
    expect(second).toEqual(first);
  });

  // --- Contract: shared enum pinned to the pgEnum (api-spec §8.6) ----------------

  it('pins syncConflictStatusSchema to the sync_conflict_status pgEnum', () => {
    expect([...syncConflictStatusSchema.options].sort()).toEqual(
      [...syncConflictStatus.enumValues].sort(),
    );
  });
});
