import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import { property, tenant } from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';
import { AppModule } from '../app.module';
import { DbService } from './db.service';
import { TenantDbService } from './tenant-db.service';
import { testSlug } from '../test-helpers';

// The transaction seam (#72). These assert the ONE thing the HTTP tests can't:
// that nested run() calls land in the same transaction, so a service can
// compose repository calls into a unit of work. The delete-guard tests in
// properties-crud.spec.ts are the behaviour net; these are the mechanism.
describe('TenantDbService.run — transaction seam', () => {
  let app: INestApplication;
  let dbs: DbService;
  let db: TenantDbService;
  let cls: ClsService;
  let tenantCtx: TenantContext;
  let tenantId: string;
  let otherTenantId: string;

  /**
   * Postgres assigns one transaction id per transaction, so two calls
   * reporting the same id proves they share one - and different ids prove
   * they don't. This is the claim under test, asserted directly rather than
   * through a proxy for it.
   */
  const xactId = async (tx: {
    execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }>;
  }): Promise<string> => {
    const res = await tx.execute(sql`select pg_current_xact_id() as id`);
    return String((res.rows[0] as { id: string | number }).id);
  };

  /** Every run() below needs a principal, the same way a real request has one. */
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    cls.run(() => {
      tenantCtx.set({
        kind: 'user',
        userId: randomUUID(),
        tenantId,
        role: 'owner',
      });
      return fn();
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dbs = app.get(DbService);
    db = app.get(TenantDbService);
    cls = app.get(ClsService);
    tenantCtx = app.get(TenantContext);

    const rows = await dbs.db
      .insert(tenant)
      .values([{ name: 'Txn Seam Test' }, { name: 'Txn Seam Other' }])
      .returning({ id: tenant.id });
    tenantId = rows[0].id;
    otherTenantId = rows[1].id;
  });

  // The principal-switch test below stubs a getter on the shared TenantContext.
  // Without this, that stub outlives its test and every later one silently runs
  // as the wrong tenant - a stub that escapes its test is a flaky suite waiting
  // for someone to add a test after it. (`restoreMocks` isn't on in this config.)
  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await dbs.db
      .delete(tenant)
      .where(inArray(tenant.id, [tenantId, otherTenantId]));
    await app.close();
  });

  it('joins the outer transaction when nested', async () => {
    const [a, b] = await asTenant(() =>
      db.run(async () => {
        const first = await db.run(xactId);
        const second = await db.run(xactId);
        return [first, second];
      }),
    );
    expect(a).toBe(b);
  });

  it('opens separate transactions when not nested', async () => {
    const [a, b] = await asTenant(async () => [
      await db.run(xactId),
      await db.run(xactId),
    ]);
    expect(a).not.toBe(b);
  });

  it('rolls back work done by nested calls when the outer run throws', async () => {
    const name = `rollback-${randomUUID()}`;
    await expect(
      asTenant(() =>
        db.run(async () => {
          await db.run((tx) =>
            tx
              .insert(property)
              .values({ tenantId, name, slug: testSlug() })
              .returning(),
          );
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');

    const rows = await dbs.db
      .select({ id: property.id })
      .from(property)
      .where(eq(property.name, name));
    expect(rows).toHaveLength(0);
  });

  it('commits nested writes when the outer run returns', async () => {
    const name = `commit-${randomUUID()}`;
    await asTenant(() =>
      db.run(async () => {
        await db.run((tx) =>
          tx
            .insert(property)
            .values({ tenantId, name, slug: testSlug() })
            .returning(),
        );
      }),
    );

    const rows = await dbs.db
      .select({ id: property.id })
      .from(property)
      .where(eq(property.name, name));
    expect(rows).toHaveLength(1);
  });

  it('refuses to join a transaction that has already settled', async () => {
    // Fire-and-forget work started inside run() keeps the ALS store but
    // outlives the transaction. Joining then would run on whatever connection
    // the pool has since handed the handle to - another tenant's, under their
    // GUC. It must fail loudly instead.
    // The catch is attached in-chain: a deferred rejection with no handler
    // would surface as an unhandled rejection, not a test result.
    let outcome!: Promise<{ joined: boolean; error?: string }>;
    await asTenant(() =>
      db.run(() => {
        outcome = new Promise((resolve) => setImmediate(resolve))
          .then(() => db.run(xactId))
          .then(() => ({ joined: true }))
          .catch((e: Error) => ({ joined: false, error: e.message }));
        return Promise.resolve();
      }),
    );

    const result = await outcome;
    expect(result.joined).toBe(false);
    expect(result.error).toMatch(/already settled/);
  });

  it('refuses a statement issued after its transaction settled', async () => {
    // The other half of the same hole: this call ENTERS run while the
    // transaction is alive, so an entry-time check passes it - then awaits,
    // and its statement lands after COMMIT, on a connection the pool has since
    // handed to someone else.
    let outcome!: Promise<{ ran: boolean; error?: string }>;
    await asTenant(() =>
      db.run((tx) => {
        outcome = new Promise((resolve) => setImmediate(resolve))
          .then(() => xactId(tx))
          .then(() => ({ ran: true }))
          .catch((e: Error) => ({ ran: false, error: e.message }));
        return Promise.resolve();
      }),
    );

    const result = await outcome;
    expect(result.ran).toBe(false);
    expect(result.error).toMatch(/after its transaction settled/);
  });

  it('refuses a query BUILT inside run and awaited after it settles', async () => {
    // #75: the residual the handle proxy could not reach. Drizzle's builders are
    // lazy thenables - tx.select().from() issues no SQL until awaited. Built
    // while the transaction is alive (a handle-level guard passes it), awaited
    // after it settles, it would otherwise execute on a recycled connection
    // under another tenant's GUC. The issue-site guard must fire when it runs.
    let deferred!: Promise<unknown>;
    await asTenant(() =>
      db.run((tx) => {
        deferred = tx.select().from(property); // built alive, deliberately not awaited
        return Promise.resolve();
      }),
    );

    // A real caller `await`s the deferred query; that converts drizzle's
    // synchronous prepareQuery throw (its thenable's .then calls execute()
    // eagerly) into a rejection. Capture it the same way rather than through
    // expect().rejects, which does not adopt a thenable that throws from .then.
    let caught: Error | undefined;
    try {
      await deferred;
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/after its transaction settled/);
  });

  it('allows a query built and awaited inside the same run', async () => {
    // The guard must not break normal use: a lazy builder awaited while the
    // transaction is alive issues through the same prepareQuery, alive still true.
    const rows = await asTenant(() =>
      db.run(async (tx) =>
        tx.select({ id: property.id }).from(property).limit(1),
      ),
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  it('throws when there is no principal', async () => {
    // Not belt-and-braces: with no GUC, RLS returns nothing on a cold
    // connection and errors 22P02 on a warm one (#74). Two different failures
    // depending on which connection the pool hands you is not a design.
    await expect(cls.run(() => db.run(xactId))).rejects.toThrow(
      /Tenant context is empty/,
    );
  });

  /**
   * The GUC belongs to the outer transaction and can't be changed for one nested
   * call, so joining under a different principal would silently run this work
   * under the wrong tenant's scope.
   *
   * The switch is FORCED with a stub, because the legitimate door is now shut:
   * this test used to call `tenantCtx.set()` a second time, and since #46's
   * review that throws (one request, one principal). Two layers, and this one is
   * proven alone - the same standard architecture §3.3 sets for the app filter
   * and RLS. A guard only ever exercised behind another guard is a guard nobody
   * has actually tested.
   */
  it('refuses to join a transaction opened for a different tenant', async () => {
    await expect(
      asTenant(() =>
        db.run(async () => {
          jest
            .spyOn(tenantCtx, 'tenantId', 'get')
            .mockReturnValue(otherTenantId);
          return db.run(xactId);
        }),
      ),
    ).rejects.toThrow(/principal changed inside an open transaction/);
  });

  /**
   * The outer half of the same protection (#46 review): the switch above cannot
   * be reached through TenantContext at all. PublicScope is globally injectable,
   * so without this a guarded route calling `enterFromSlug` would silently swap
   * its Owner for a Visitor of whatever tenant owns that slug - and `run` only
   * compares principals INSIDE an open transaction, so outside one it would just
   * open a new one under the wrong tenant.
   */
  it('cannot re-mint a principal over an existing one', () => {
    expect(() =>
      cls.run(() => {
        tenantCtx.set({
          kind: 'user',
          userId: randomUUID(),
          tenantId,
          role: 'owner',
        });
        tenantCtx.set({ kind: 'visitor', tenantId: otherTenantId });
      }),
    ).toThrow(/already minted/);
  });

  it('assertInTransaction throws outside a run', () => {
    expect(() => db.assertInTransaction('probe')).toThrow(
      /must be called inside TenantDbService\.run/,
    );
  });

  it('assertInTransaction passes inside a run', async () => {
    await asTenant(() =>
      db.run(() => {
        expect(() => db.assertInTransaction('probe')).not.toThrow();
        return Promise.resolve();
      }),
    );
  });

  it('a joined call inherits the outer transaction tenant GUC', async () => {
    // Regression guard, not proof of the join: this would also pass if the
    // nested call opened its own transaction and set the GUC itself. What it
    // does prove is that RLS scoping doesn't depend on nesting depth.
    const guc = await asTenant(() =>
      db.run(async () =>
        db.run(async (tx) => {
          const res = await tx.execute(
            sql`select current_setting('app.tenant_id', true) as t`,
          );
          return (res.rows[0] as { t: string | null }).t;
        }),
      ),
    );
    expect(guc).toBe(tenantId);
  });
});
