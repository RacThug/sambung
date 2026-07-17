import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { sql } from 'drizzle-orm';
import { createDb, type DbTx } from '@sambung/db';
import type { TenantPrincipal } from '../common/tenant-context.service';

// Tenant-scoped database access (boss fight #5, app layer). Every callback
// runs inside a transaction on the NON-OWNER app role that first sets
// `app.tenant_id` via parameterized set_config (no SQL injection). Combined
// with the RLS policies, the database itself scopes every query to the current
// tenant. No tenant in context (a system path) → the GUC stays unset; RLS is
// fail-closed, so those queries return nothing.
//
// Two ambient stores, two questions, deliberately kept apart:
//   CLS (mounted by middleware) → WHO is asking: the request's principal.
//   activeTx (owned by this class) → WHICH transaction we are already inside.
// activeTx is not on the CLS store because the CLS store only exists for the
// duration of an HTTP request. A transaction's scope is `run` itself, which
// must also hold for the M2 hold-sweeper cron and for tests that call
// repositories directly — both run with no CLS store mounted.
@Injectable()
export class TenantDbService implements OnModuleDestroy {
  private readonly conn: ReturnType<typeof createDb>;
  private readonly activeTx = new AsyncLocalStorage<DbTx>();

  constructor(
    config: ConfigService,
    private readonly cls: ClsService,
  ) {
    this.conn = createDb(config.getOrThrow<string>('APP_DATABASE_URL'));
  }

  /**
   * Run tenant-scoped queries - use this for all tenant-owned reads/writes.
   *
   * Nested calls JOIN the open transaction instead of opening a new one, so a
   * service can compose several repository calls into one unit of work while
   * each repository method still works standalone. The outermost call owns
   * BEGIN/COMMIT and sets the GUC; joined calls inherit both.
   *
   * The join is FLAT - not a savepoint. Postgres aborts the whole transaction
   * on any error (25P02: "current transaction is aborted"), so catching a
   * failure from a nested run and carrying on does NOT work: the next
   * statement fails too. Code that must survive a per-item failure (the M4
   * per-VEVENT iCal loop, db-design §4.8) needs a savepoint, which drizzle
   * spells `tx.transaction(...)`. Add it when that caller exists.
   */
  run<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const joined = this.activeTx.getStore();
    if (joined) {
      // Already inside a transaction that set the GUC - reuse both.
      return fn(joined);
    }
    const tenantId = this.cls.get<TenantPrincipal>('principal')?.tenantId;
    return this.conn.db.transaction(async (tx) => {
      if (tenantId) {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
      }
      return this.activeTx.run(tx, () => fn(tx));
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.conn.close();
  }
}
