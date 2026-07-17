import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import { property, tenant } from '@sambung/db';
import { AppModule } from '../app.module';
import { DbService } from './db.service';
import { TenantDbService } from './tenant-db.service';

// The transaction seam (#72). These assert the ONE thing the HTTP tests can't:
// that nested run() calls land in the same transaction, so a service can
// compose repository calls into a unit of work. The delete-guard tests in
// properties-crud.spec.ts are the behaviour net; these are the mechanism.
describe('TenantDbService.run — transaction seam', () => {
  let app: INestApplication;
  let dbs: DbService;
  let db: TenantDbService;
  let cls: ClsService;
  let tenantId: string;

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
      cls.set('principal', { userId: randomUUID(), tenantId, role: 'owner' });
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

    const [row] = await dbs.db
      .insert(tenant)
      .values({ name: 'Txn Seam Test' })
      .returning({ id: tenant.id });
    tenantId = row.id;
  });

  afterAll(async () => {
    await dbs.db.delete(tenant).where(eq(tenant.id, tenantId));
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
            tx.insert(property).values({ tenantId, name }).returning(),
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
          tx.insert(property).values({ tenantId, name }).returning(),
        );
      }),
    );

    const rows = await dbs.db
      .select({ id: property.id })
      .from(property)
      .where(eq(property.name, name));
    expect(rows).toHaveLength(1);
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
