import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { closeDb, createDb, db, pgError } from '../src/index';
import * as schema from '../src/schema';
import {
  appUser,
  booking,
  channelConnection,
  payment,
  paymentEvent,
  property,
  syncConflict,
  tenant,
  unit,
  userProperty,
} from '../src/schema';
import { expectDbError } from './helpers';
import { testSlug } from "./helpers";

// Row-Level Security (boss fight #5, DB layer). The ONLY tests in the repo that
// exercise the policies: every other db test connects as the owner, which is
// exempt from them, so they cannot see a policy at all.
//
// Fixtures are seeded as the owner (RLS off) and read back through a SECOND
// connection on the non-owner app role (RLS on). Two tenants, A and B, with a
// full row per table - so each policy is asked the same question: as A, is B's
// row invisible?
describe('RLS policies', () => {
  // The app role. Everything under test happens on this connection.
  const appConn = createDb(process.env.APP_DATABASE_URL ?? '');
  const appDb = appConn.db;

  let tenantA: string;
  let tenantB: string;
  const ids: Record<string, { a: string; b: string }> = {};

  type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

  /**
   * Set the session GUCs for one transaction, exactly as TenantDbService does.
   *
   * All THREE of them since #57 (ADR-0032). An Owner's transaction is
   * `property_scope = 'all'`, which is what makes the property term in every
   * policy pass unconditionally - so these tests still ask the tenant question
   * and only the tenant question.
   */
  const asPrincipal = async <T>(
    tenantId: string,
    scope: { mode: 'all' | 'assigned'; staffUserId: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> =>
    appDb.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true),
                   set_config('app.property_scope', ${scope.mode}, true),
                   set_config('app.staff_user_id', ${scope.staffUserId}, true)`,
      );
      return fn(tx);
    });

  /** An Owner of this tenant: scoped by tenant, unscoped within it. */
  const asTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    asPrincipal(tenantId, { mode: 'all', staffUserId: '' }, fn);

  /** A staff member: scoped by tenant AND by their user_property grants. */
  const asStaff = <T>(
    tenantId: string,
    staffUserId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> =>
    asPrincipal(tenantId, { mode: 'assigned', staffUserId }, fn);

  /** Seed one tenant's full row set through the owner connection. */
  async function seed(name: string) {
    const [t] = await db
      .insert(tenant)
      .values({ name })
      .returning({ id: tenant.id });
    const [u] = await db
      .insert(appUser)
      .values({
        tenantId: t.id,
        email: `rls-${t.id}@test.dev`,
        passwordHash: 'x',
        role: 'owner',
      })
      .returning({ id: appUser.id });
    const [p] = await db
      .insert(property)
      .values({ tenantId: t.id, name: `${name} Villa`, slug: testSlug() })
      .returning({ id: property.id });
    const [un] = await db
      .insert(unit)
      .values({
        tenantId: t.id,
        propertyId: p.id,
        name: 'Room',
        basePriceIdr: 500_000n,
      })
      .returning({ id: unit.id });
    const [cc] = await db
      .insert(channelConnection)
      .values({
        tenantId: t.id,
        unitId: un.id,
        channel: 'airbnb',
        importIcalUrl: 'https://example.com/c.ics',
      })
      .returning({ id: channelConnection.id });
    const [b] = await db
      .insert(booking)
      .values({
        tenantId: t.id,
        unitId: un.id,
        source: 'direct',
        status: 'confirmed',
        checkIn: '2027-01-10',
        checkOut: '2027-01-13',
      })
      .returning({ id: booking.id });
    const [pay] = await db
      .insert(payment)
      .values({ bookingId: b.id, provider: 'midtrans', amountIdr: 1_000_000n })
      .returning({ id: payment.id });
    const [pe] = await db
      .insert(paymentEvent)
      .values({
        provider: 'midtrans',
        providerEventId: `evt-${b.id}`,
        bookingId: b.id,
      })
      .returning({ id: paymentEvent.id });
    await db
      .insert(userProperty)
      .values({ appUserId: u.id, propertyId: p.id, tenantId: t.id });
    return { tenantId: t.id, user: u.id, prop: p.id, unit: un.id, cc: cc.id, booking: b.id, payment: pay.id, event: pe.id };
  }

  beforeAll(async () => {
    const a = await seed('RLS Tenant A');
    const b = await seed('RLS Tenant B');
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    ids.tenant = { a: a.tenantId, b: b.tenantId };
    ids.app_user = { a: a.user, b: b.user };
    ids.property = { a: a.prop, b: b.prop };
    ids.unit = { a: a.unit, b: b.unit };
    ids.channel_connection = { a: a.cc, b: b.cc };
    ids.booking = { a: a.booking, b: b.booking };
    ids.payment = { a: a.payment, b: b.payment };
    ids.payment_event = { a: a.event, b: b.event };
    ids.user_property = { a: a.prop, b: b.prop };
  });

  afterAll(async () => {
    await db.delete(tenant).where(inArray(tenant.id, [tenantA, tenantB]));
    await appConn.close();
    await closeDb();
  });

  // Every policied table, and the column that identifies a row. 0002 ALTERs one
  // policy per entry - a typo in any of them (especially the three EXISTS
  // subqueries, which have never had a test) would otherwise ship silently.
  const cases = [
    { name: 'tenant', table: tenant, col: tenant.id },
    { name: 'app_user', table: appUser, col: appUser.id },
    { name: 'property', table: property, col: property.id },
    { name: 'unit', table: unit, col: unit.id },
    {
      name: 'channel_connection',
      table: channelConnection,
      col: channelConnection.id,
    },
    { name: 'booking', table: booking, col: booking.id },
    // Child tables with no tenant_id of their own - scoped via an EXISTS on
    // their parent. Different predicate shape, same question.
    { name: 'payment', table: payment, col: payment.id },
    { name: 'payment_event', table: paymentEvent, col: paymentEvent.id },
    { name: 'user_property', table: userProperty, col: userProperty.propertyId },
  ];

  // One per policy: as tenant A, B's row must be invisible.
  describe('scope every table to the GUC tenant', () => {
    for (const { name, table, col } of cases) {
      it(`${name}: tenant A sees its own row and not tenant B's`, async () => {
        const rows = await asTenant(tenantA, (tx) =>
          tx
            .select({ id: col })
            .from(table)
            .where(inArray(col, [ids[name].a, ids[name].b])),
        );
        const seen = rows.map((r) => r.id);
        expect(seen).toContain(ids[name].a);
        expect(seen).not.toContain(ids[name].b);
      });
    }
  });

  // The #74 regression, and the reason this file exists.
  //
  // set_config(..., true) reverts at COMMIT to the GUC's RESET value, which for
  // a custom GUC already set once on the session is '' - NOT unset. So the
  // connection must be WARMED first: a cold one reports NULL and fails closed
  // even under the OLD predicate, so a cold test passes against the bug it is
  // meant to catch.
  //
  // Which means these tests cannot use `appDb`: it is a pg Pool (default
  // max=10), and a pool hands each query whichever backend is free. Warming one
  // backend and then firing nine queries warms 1 and opens 8 fresh, cold ones -
  // measured, 8 of 9 assertions passed against the unfixed predicate. A single
  // pinned Client is the only way to guarantee every query lands on the backend
  // we warmed. (A pool client is also destroyed on query error, so even a
  // sequential loop would go cold after the first failure.)
  describe('fail closed with no tenant in context', () => {
    let client: Client;
    let warmDb: NodePgDatabase<typeof schema>;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.APP_DATABASE_URL });
      await client.connect();
      warmDb = drizzle(client, { schema });
      // One tenant-scoped transaction: after it commits, the GUC's reset value
      // on THIS backend is '' rather than unset. That is the whole premise.
      await warmDb.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantA}, true)`,
        );
        await tx.select({ id: property.id }).from(property);
      });
    });

    afterAll(async () => {
      await client.end();
    });

    it('the GUC resets to empty string, not NULL - the premise of #74', async () => {
      const res = await warmDb.execute<{ raw: string | null; isNull: boolean }>(
        sql`select current_setting('app.tenant_id', true) as raw,
                   current_setting('app.tenant_id', true) is null as "isNull"`,
      );
      const row = (res.rows as Array<{ raw: string | null; isNull: boolean }>)[0];
      // If this ever reports isNull=true, the connection went cold and every
      // assertion below is vacuous - or the reset-value behaviour changed and
      // 0002's nullif() is load-bearing for a reason that no longer holds.
      expect(row.isNull).toBe(false);
      expect(row.raw).toBe('');
    });

    it('every policy fails closed, all on the one warmed backend', async () => {
      // Sequential, on the pinned client: no set_config anywhere, so the GUC is
      // '' for all nine. Before 0002 every one of these threw 22P02, `invalid
      // input syntax for type uuid: ""`. Both predicate shapes are covered -
      // six direct, three EXISTS.
      //
      // Outcomes are collected rather than asserted per query, so a regression
      // reports all nine policies instead of dying on the first. (Verified the
      // pinned Client survives an error: unlike a pool client, it isn't
      // destroyed, so the backend - and its warm '' GUC - persists. The pid
      // assertion below is what proves that.)
      const pid = async () =>
        (
          (await warmDb.execute<{ pid: number }>(
            sql`select pg_backend_pid() as pid`,
          )).rows as Array<{ pid: number }>
        )[0].pid;
      const before = await pid();

      const outcomes: Record<string, string> = {};
      for (const { name, table, col } of cases) {
        try {
          const rows = await warmDb.select({ id: col }).from(table);
          outcomes[name] =
            rows.length === 0 ? 'closed' : `LEAKED ${rows.length} rows`;
        } catch (e) {
          outcomes[name] = `ERROR ${pgError(e)?.code ?? 'unknown'}`;
        }
      }

      expect(outcomes).toEqual(
        Object.fromEntries(cases.map((c) => [c.name, 'closed'])),
      );
      // Same backend before and after, so every query above ran warm - and the
      // errors (if any) didn't silently reconnect us onto a cold one, which
      // would make the assertion vacuous.
      expect(await pid()).toBe(before);
    });
  });

  // WITH CHECK is the write half of every policy: USING filters what you can
  // read, WITH CHECK refuses what you'd write outside your scope. Asserted on
  // SQLSTATE rather than message text, like the other db tests - drizzle wraps
  // the pg error, so the top-level message is only "Failed query: ...".
  it('WITH CHECK refuses a write scoped to another tenant', async () => {
    await expectDbError(
      asTenant(tenantA, (tx) =>
        tx
          .insert(property)
          .values({ tenantId: tenantB, name: 'Smuggled', slug: testSlug() }),
      ),
      '42501', // insufficient_privilege: new row violates RLS policy
    );
  });

  /**
   * The SECOND axis (#57, ADR-0032): within one tenant, a staff member sees only
   * the Properties assigned to them.
   *
   * The fixture is the whole point - tenant A gets a SECOND property with its own
   * unit, booking, payment, connection and conflict, and the staff user is
   * assigned only to the FIRST. So every assertion below is intra-tenant: the
   * tenant term passes for both rows and the property term is the only thing
   * that can separate them.
   */
  describe('scope to assigned properties (staff)', () => {
    let staff: string;
    let assigned: { property: string; unit: string; booking: string; payment: string; cc: string; conflict: string };
    let unassigned: typeof assigned;

    /** One property and everything hanging off it, inside tenant A. */
    async function branch(name: string) {
      const [p] = await db
        .insert(property)
        .values({ tenantId: tenantA, name, slug: testSlug() })
        .returning({ id: property.id });
      const [un] = await db
        .insert(unit)
        .values({
          propertyId: p.id,
          tenantId: tenantA,
          name: `${name} Room`,
          basePriceIdr: 500_000n,
        })
        .returning({ id: unit.id });
      const [cc] = await db
        .insert(channelConnection)
        .values({
          tenantId: tenantA,
          unitId: un.id,
          channel: 'airbnb',
          importIcalUrl: `https://example.com/${name}.ics`,
        })
        .returning({ id: channelConnection.id });
      const [b] = await db
        .insert(booking)
        .values({
          tenantId: tenantA,
          unitId: un.id,
          source: 'direct',
          status: 'confirmed',
          checkIn: '2027-03-01',
          checkOut: '2027-03-04',
        })
        .returning({ id: booking.id });
      const [pay] = await db
        .insert(payment)
        .values({ bookingId: b.id, provider: 'midtrans', amountIdr: 500_000n })
        .returning({ id: payment.id });
      const [sc] = await db
        .insert(syncConflict)
        .values({
          tenantId: tenantA,
          channelConnectionId: cc.id,
          unitId: un.id,
          externalUid: `uid-${name}`,
          checkIn: '2027-03-01',
          checkOut: '2027-03-04',
        })
        .returning({ id: syncConflict.id });
      return {
        property: p.id,
        unit: un.id,
        booking: b.id,
        payment: pay.id,
        cc: cc.id,
        conflict: sc.id,
      };
    }

    beforeAll(async () => {
      assigned = await branch('Assigned');
      unassigned = await branch('Unassigned');
      const [s] = await db
        .insert(appUser)
        .values({
          tenantId: tenantA,
          email: `rls-staff-${tenantA}@test.dev`,
          passwordHash: 'x',
          role: 'staff',
        })
        .returning({ id: appUser.id });
      staff = s.id;
      await db.insert(userProperty).values({
        appUserId: staff,
        propertyId: assigned.property,
        tenantId: tenantA,
      });
    });

    // One row per table, both branches, one query each: the assigned id must be
    // visible and the unassigned id must not. `payment` is in this list on
    // purpose - migration 0015 does NOT restate the property term on its policy,
    // relying on `booking`'s policy applying inside its EXISTS subquery. That is
    // a rewriter behaviour, not something to take on faith for a money table, so
    // this is the assertion that pins it.
    const scoped = [
      { name: 'property', col: property.id, table: property, key: 'property' },
      { name: 'unit', col: unit.id, table: unit, key: 'unit' },
      { name: 'booking', col: booking.id, table: booking, key: 'booking' },
      {
        name: 'channel_connection',
        col: channelConnection.id,
        table: channelConnection,
        key: 'cc',
      },
      {
        name: 'sync_conflict',
        col: syncConflict.id,
        table: syncConflict,
        key: 'conflict',
      },
      { name: 'payment', col: payment.id, table: payment, key: 'payment' },
    ] as const;

    for (const { name, col, table, key } of scoped) {
      it(`${name}: staff sees the assigned property's row, not the unassigned one`, async () => {
        const rows = await asStaff(tenantA, staff, (tx) =>
          tx
            .select({ id: col })
            .from(table)
            .where(inArray(col, [assigned[key], unassigned[key]])),
        );
        const seen = rows.map((r) => r.id);
        expect(seen).toEqual([assigned[key]]);
      });

      it(`${name}: the owner of the same tenant sees BOTH`, async () => {
        const rows = await asTenant(tenantA, (tx) =>
          tx
            .select({ id: col })
            .from(table)
            .where(inArray(col, [assigned[key], unassigned[key]])),
        );
        // The control. Without it, a policy that filtered everything would pass
        // every assertion above while breaking the product.
        expect(rows.map((r) => r.id).sort()).toEqual(
          [assigned[key], unassigned[key]].sort(),
        );
      });
    }

    it('a direct read by id of an unassigned property returns nothing, not an error', async () => {
      // This is what makes "404 for unassigned" true at the HTTP layer without a
      // single service changing: every getter already turns zero rows into a
      // NotFoundException, and RLS makes the row zero.
      const rows = await asStaff(tenantA, staff, (tx) =>
        tx
          .select({ id: property.id })
          .from(property)
          .where(inArray(property.id, [unassigned.property])),
      );
      expect(rows).toEqual([]);
    });

    it('staff cannot grant themselves a property - WITH CHECK refuses the write', async () => {
      await expectDbError(
        asStaff(tenantA, staff, (tx) =>
          tx.insert(userProperty).values({
            appUserId: staff,
            propertyId: unassigned.property,
            tenantId: tenantA,
          }),
        ),
        '42501',
      );
    });

    it('staff reads their OWN grants only, not the whole roster', async () => {
      const [owner] = await asTenant(tenantA, (tx) =>
        tx.select({ id: appUser.id }).from(appUser).where(inArray(appUser.role, ['owner'])),
      );
      // The owner's own user_property row (seeded in `seed`) belongs to someone
      // else; a staff member has no business enumerating who else can see what.
      const rows = await asStaff(tenantA, staff, (tx) =>
        tx.select({ appUserId: userProperty.appUserId }).from(userProperty),
      );
      expect(rows.map((r) => r.appUserId)).toEqual([staff]);
      expect(rows.map((r) => r.appUserId)).not.toContain(owner.id);
    });

    it('a staff scope with no matching grants sees nothing - it does not fall open', async () => {
      // The failure this design is built to prevent: "restricted" must never
      // degrade into "unrestricted" when the restriction matches no rows.
      const rows = await asStaff(tenantA, unassigned.property /* not a user id */, (tx) =>
        tx.select({ id: property.id }).from(property),
      );
      expect(rows).toEqual([]);
    });

    it('the property term cannot be bypassed by naming another tenant\'s staff', async () => {
      // A staff user id from tenant B, presented inside tenant A's scope. The
      // tenant term already refuses it; this pins that the two axes are ANDed,
      // never ORed.
      const rows = await asStaff(tenantB, staff, (tx) =>
        tx.select({ id: property.id }).from(property),
      );
      expect(rows).toEqual([]);
    });
  });

  it('the app role is actually subject to RLS - the premise of this file', async () => {
    const [row] = await asTenant(tenantA, (tx) =>
      tx
        .execute<{ active: boolean }>(
          sql`select row_security_active('property') as active`,
        )
        .then((r) => r.rows as Array<{ active: boolean }>),
    );
    // If this were false the whole suite would pass vacuously: the owner
    // bypasses every policy, so it would see everything and scope nothing.
    expect(row.active).toBe(true);
  });
});
