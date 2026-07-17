import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { createDb, type DbTx } from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';

/**
 * The open transaction, plus whether it is still open.
 *
 * `alive` guards against a stale handle. Async work started inside `run` keeps
 * the ALS store after the transaction settles and its connection returns to
 * the pool, so a late query would otherwise execute on a recycled connection -
 * inside whatever transaction now owns it, under that tenant's GUC. Silent
 * cross-tenant contamination.
 *
 * `guarded` is what callers actually get. Checking `alive` only when `run` is
 * entered is not enough: a call that enters while the transaction is alive and
 * then awaits anything lands its statements arbitrarily later, after the
 * connection has moved on. The check has to happen when a statement is issued,
 * which is what the proxy does.
 *
 * `tenantId` is the tenant this transaction's GUC was set to. A joined call
 * inherits that GUC whether or not it is still the right one, so joining
 * compares against it rather than trusting the caller.
 */
interface ActiveTx {
  readonly tx: DbTx;
  readonly tenantId: string;
  guarded: DbTx;
  alive: boolean;
}

/**
 * Wrap a transaction so that every call made through this handle asserts the
 * transaction is still open.
 *
 * Scope, precisely - it guards CALLS THROUGH THE HANDLE, nothing wider. A
 * query *built* here and executed later still escapes: drizzle's builders are
 * lazy thenables holding the raw session, so `const q = tx.select().from(x)`
 * inside the callback and `await q` after it returns lands on whichever
 * transaction now owns the connection. Narrower door than an un-awaited query,
 * same blast radius. Tracked as #75; unreachable today.
 *
 * Do not read this as enforcing "work started inside run() must be awaited
 * before it returns" in general. Claiming that was the bug in the first
 * attempt at this guard, which checked liveness only when `run` was entered.
 */
function guardTx(tx: DbTx, active: ActiveTx): DbTx {
  return new Proxy(tx, {
    get(target, prop) {
      // Read without the proxy as receiver: drizzle's internals use private
      // fields, which throw if accessed through a proxy receiver.
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (!active.alive) {
          throw new Error(
            'TenantDbService: statement issued after its transaction settled. ' +
              'Work started inside run() must be awaited before the callback ' +
              'returns - otherwise the query lands on a pooled connection that ' +
              'has moved on to another transaction, and another tenant.',
          );
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

// Tenant-scoped database access (boss fight #5, app layer). Every callback
// runs inside a transaction on the NON-OWNER app role that first sets
// `app.tenant_id` via parameterized set_config (no SQL injection). Combined
// with the RLS policies, the database itself scopes every query to the current
// tenant.
//
// Callers MUST have a principal: `run` throws without one rather than querying
// with the GUC unset. A request that reached a tenant-scoped query with no
// tenant is a bug, and it should say so here rather than three calls later as
// an empty result the caller reads as "no data".
//
// RLS is the second layer, not the first, and it does now genuinely fail closed
// on any connection - the policies compare against nullif(current_setting(...),
// ''), so both the unset (NULL) and reset ('') cases filter every row (#74,
// migration 0002). Before that they cast the GUC directly, which errored 22P02
// on a pooled connection that had already served a request: set_config(...,
// is_local => true) reverts to the GUC's *reset* value, and for a custom GUC
// already set once on that session the reset value is '' rather than unset.
//
// Work that legitimately has no principal does NOT belong here:
//   crosses tenants (the M2 hold sweeper) → DbService, the owner connection.
//   unauthenticated (the M2 public funnel) → undesigned, see #77.
//
// Two ambient stores, two questions, deliberately kept apart:
//   TenantContext (CLS, mounted by middleware) → WHO is asking.
//   activeTx (owned by this class) → WHICH transaction we are already inside.
// activeTx is not on the CLS store because the CLS store only exists for the
// duration of an HTTP request, whereas a transaction's scope is `run` itself.
// The principal is read through TenantContext, never from CLS directly: that
// module owns the key, so a rename is a compile error rather than silent
// zero-row scoping.
@Injectable()
export class TenantDbService implements OnModuleDestroy {
  private readonly conn: ReturnType<typeof createDb>;
  private readonly activeTx = new AsyncLocalStorage<ActiveTx>();

  constructor(
    config: ConfigService,
    private readonly tenant: TenantContext,
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
   *
   * `async` is load-bearing: it makes a synchronously-throwing callback reject
   * rather than throw, so both the joined and non-joined paths report failure
   * on the same channel.
   *
   * Throws when there is no principal - see the note on this class.
   */
  async run<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    // Throws with no principal. Deliberately the same getter services use, so
    // both doors answer a missing tenant the same way.
    const tenantId = this.tenant.tenantId;
    const joined = this.activeTx.getStore();
    if (joined) {
      if (!joined.alive) {
        // Deferred work outliving its transaction. Joining here would run on
        // whichever connection the pool has since handed the handle to.
        throw new Error(
          'TenantDbService.run: the surrounding transaction has already ' +
            'settled. Work started inside run() must be awaited before it ' +
            'returns - a deferred query cannot join a closed transaction.',
        );
      }
      if (joined.tenantId !== tenantId) {
        // The GUC belongs to the outer transaction and cannot be changed for
        // one nested call, so joining would silently run this work under the
        // wrong tenant's scope.
        throw new Error(
          'TenantDbService.run: the principal changed inside an open ' +
            `transaction (opened for ${joined.tenantId}, now ${tenantId}). ` +
            'One unit of work belongs to one tenant.',
        );
      }
      // Already inside a live transaction that set the GUC - reuse both.
      return fn(joined.guarded);
    }
    return this.conn.db.transaction(async (tx) => {
      const active = { tx, tenantId, alive: true } as ActiveTx;
      active.guarded = guardTx(tx, active);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      try {
        return await this.activeTx.run(active, () => fn(active.guarded));
      } finally {
        // Runs before drizzle issues COMMIT/ROLLBACK, so nothing can reach the
        // connection between the callback returning and the transaction closing.
        active.alive = false;
      }
    });
  }

  /**
   * Throw unless the caller is already inside a `run`. For repository methods
   * whose whole purpose is to affect the surrounding transaction - a row lock
   * taken in its own transaction is released immediately and locks nothing, so
   * returning normally would be a lie. Makes that silent no-op loud.
   */
  assertInTransaction(caller: string): void {
    const joined = this.activeTx.getStore();
    if (!joined?.alive) {
      throw new Error(
        `${caller} must be called inside TenantDbService.run - outside one it ` +
          'would open its own transaction, and any lock it takes would be ' +
          'released before the caller could rely on it.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.conn.close();
  }
}
