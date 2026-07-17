import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { closeDb, createDb, db } from '../src/index';
import {
  appUser,
  booking,
  channelConnection,
  payment,
  paymentEvent,
  property,
  tenant,
  unit,
  userProperty,
} from '../src/schema';
import { expectDbError } from './helpers';

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

  /** Set the tenant GUC for one transaction, exactly as TenantDbService does. */
  const asTenant = async <T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> =>
    appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });

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
      .values({ tenantId: t.id, name: `${name} Villa` })
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
    await db.insert(userProperty).values({ appUserId: u.id, propertyId: p.id });
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

  // One per policy: as tenant A, B's row must be invisible. Each ALTER in
  // 0002 changes one of these predicates - untested, a typo in any of them
  // (especially the three EXISTS subqueries) would ship silently.
  describe('scope every table to the GUC tenant', () => {
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
  // connection must be WARMED first: a cold connection returns NULL and passes
  // this test even with the old predicate, proving nothing.
  describe('fail closed with no tenant in context', () => {
    /** Run one tenant-scoped transaction so the GUC's reset value becomes ''. */
    const warm = async () => {
      await asTenant(tenantA, (tx) => tx.select({ id: property.id }).from(property));
      const [row] = await appDb.execute<{ raw: string | null; isNull: boolean }>(
        sql`select current_setting('app.tenant_id', true) as raw,
                   current_setting('app.tenant_id', true) is null as "isNull"`,
      ).then((r) => r.rows as Array<{ raw: string | null; isNull: boolean }>);
      return row;
    };

    it('the GUC resets to empty string, not NULL - the premise of #74', async () => {
      const row = await warm();
      // If this ever reports isNull=true, the reset-value behaviour changed and
      // the nullif() in 0002 is load-bearing for a reason that no longer holds.
      expect(row.isNull).toBe(false);
      expect(row.raw).toBe('');
    });

    it('a direct policy returns zero rows, not 22P02', async () => {
      await warm();
      // No set_config: the GUC is '' on this connection. Before 0002 this threw
      // `invalid input syntax for type uuid: ""`.
      const rows = await appDb.select({ id: property.id }).from(property);
      expect(rows).toHaveLength(0);
    });

    it('an EXISTS policy returns zero rows, not 22P02', async () => {
      await warm();
      const rows = await appDb.select({ id: payment.id }).from(payment);
      expect(rows).toHaveLength(0);
    });

    it('every policy fails closed on a warm connection', async () => {
      await warm();
      const counts = await Promise.all([
        appDb.select({ id: tenant.id }).from(tenant),
        appDb.select({ id: appUser.id }).from(appUser),
        appDb.select({ id: property.id }).from(property),
        appDb.select({ id: unit.id }).from(unit),
        appDb.select({ id: channelConnection.id }).from(channelConnection),
        appDb.select({ id: booking.id }).from(booking),
        appDb.select({ id: payment.id }).from(payment),
        appDb.select({ id: paymentEvent.id }).from(paymentEvent),
        appDb.select({ id: userProperty.propertyId }).from(userProperty),
      ]);
      expect(counts.map((rows) => rows.length)).toEqual(Array(9).fill(0));
    });
  });

  // WITH CHECK is the write half of every policy: USING filters what you can
  // read, WITH CHECK refuses what you'd write outside your scope. Asserted on
  // SQLSTATE rather than message text, like the other db tests - drizzle wraps
  // the pg error, so the top-level message is only "Failed query: ...".
  it('WITH CHECK refuses a write scoped to another tenant', async () => {
    await expectDbError(
      asTenant(tenantA, (tx) =>
        tx.insert(property).values({ tenantId: tenantB, name: 'Smuggled' }),
      ),
      '42501', // insufficient_privilege: new row violates RLS policy
    );
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
