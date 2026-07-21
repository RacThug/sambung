import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { createDb, type DbTx } from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';

/**
 * The open transaction, its tenant, and whether it is still live.
 *
 * `alive` is the whole guard. Async work started inside `run` keeps the ALS
 * store after the transaction settles and its connection returns to the pool,
 * so a late statement would otherwise execute on a recycled connection - inside
 * whatever transaction now owns it, under that tenant's GUC. Silent cross-tenant
 * contamination. It flips false the instant the callback returns (see `run`),
 * and the guard rejects any statement issued after that.
 *
 * The guard lives where statements are ISSUED - the session's prepareQuery (see
 * `guardSession`) - not on the handle. Guarding the handle is not enough:
 * drizzle's builders are lazy thenables, so a query BUILT through the handle
 * while alive and AWAITED after `run` returns still executes after settle, and
 * the handle is never called again to catch it (#75). The check has to fire
 * where the SQL is actually issued, which every builder reaches through the one
 * session, at await time.
 *
 * `tenantId` is the tenant this transaction's GUC was set to. A joined call
 * inherits that GUC whether or not it is still the right one, so joining
 * compares against it rather than trusting the caller.
 */
interface ActiveTx {
  readonly tx: DbTx;
  readonly tenantId: string;
  alive: boolean;
}

/**
 * The narrow slice of drizzle we deliberately reach into. Two facts, both
 * pinned by the escape test in tenant-db.spec: a transaction's `session` is the
 * object that issues statements, and `prepareQuery` is the single method every
 * query funnels through - at EXECUTION time, because the builders are lazy
 * thenables that call it when awaited, not when built.
 */
interface IssuingSession {
  prepareQuery: (...args: unknown[]) => unknown;
}

/**
 * Install the liveness guard where statements are ISSUED: the transaction's
 * session, which every query funnels through at execution time.
 *
 * Why here, not on the handle. The obvious guard wraps `tx` and checks liveness
 * on each call through it. That closes an un-awaited `tx.execute(...)`, but not
 * a query built through the handle and executed later: the builders are lazy
 * thenables holding the raw session, so `tx.select().from(x)` inside the
 * callback (guard passes - built while alive) and `await` after `run` returns
 * (no guard - the handle is never called again) lands on whichever transaction
 * now owns the connection. Same blast radius as an un-awaited query, narrower
 * door - this was #75, the residual a handle proxy could not reach.
 *
 * prepareQuery is the single funnel: base execute() and count() both delegate to
 * it, and a select's _prepare() calls it when the thenable is awaited, not when
 * built. So one guard catches every shape (select/insert/update/delete/raw
 * execute/count), at the moment the statement would actually run.
 *
 * Safe to mutate in place because the session is per-transaction: a pool-backed
 * db.transaction mints a fresh session bound to the checked-out client, so this
 * guard dies with its transaction and never touches the next one on the recycled
 * connection.
 *
 * The one exception it allows is drizzle's own COMMIT/ROLLBACK - see
 * isTransactionControl. The escape test is the tripwire for the two internals
 * this leans on: if a drizzle upgrade ever routes execution around prepareQuery,
 * that test goes red rather than the isolation silently reopening.
 */
function guardSession(tx: DbTx, active: ActiveTx): void {
  const session = (tx as unknown as { session: IssuingSession }).session;
  const issue: (...args: unknown[]) => unknown = session.prepareQuery;
  session.prepareQuery = (...args: unknown[]): unknown => {
    if (!active.alive && !isTransactionControl(args[0])) {
      throw new Error(
        'TenantDbService: statement issued after its transaction settled. ' +
          'Work started inside run() - including a query BUILT here and awaited ' +
          'later - must complete before the callback returns, or it lands on a ' +
          'pooled connection that has moved on to another transaction, and ' +
          'another tenant.',
      );
    }
    // Preserve `this` - prepareQuery reaches session-internal state (client,
    // dialect) through it.
    return issue.apply(session, args);
  };
}

/**
 * `alive` flips false the instant the callback returns (see `run`), so it is
 * already false when drizzle closes the transaction by issuing COMMIT or
 * ROLLBACK through this same session (node-postgres session.transaction). Those
 * two must still pass - and rejecting the ROLLBACK would even mask the caller's
 * original error. They are transaction control, not tenant data, so allowing
 * them after settle cannot leak a row: every caller read/write
 * (select/insert/update/delete/raw execute) is still rejected. `run` uses flat
 * joins, never savepoints, so COMMIT and ROLLBACK are the only two drizzle emits
 * after the callback; a nested `tx.transaction(...)` would add savepoint verbs
 * here.
 */
function isTransactionControl(query: unknown): boolean {
  const text = (query as { sql?: unknown } | null)?.sql;
  if (typeof text !== 'string') return false;
  const normalized = text.trim().toLowerCase();
  return normalized === 'commit' || normalized === 'rollback';
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
      // Already inside a live transaction that set the GUC - reuse it. The
      // session behind this handle is guarded, so a query deferred out of the
      // nested call is caught by the outer transaction's liveness flag too.
      return fn(joined.tx);
    }
    return this.conn.db.transaction(async (tx) => {
      const active: ActiveTx = { tx, tenantId, alive: true };
      // Guard the session before the first statement, so every statement this
      // transaction issues - including the set_config below - runs through it.
      guardSession(tx, active);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      try {
        return await this.activeTx.run(active, () => fn(tx));
      } finally {
        // Flip liveness the instant the callback returns - synchronously, before
        // drizzle issues COMMIT. A statement deferred out of the callback then
        // finds a settled transaction and is rejected, even if it fires during
        // the commit round-trip. drizzle's own COMMIT/ROLLBACK, which run through
        // this same guarded session afterwards, still pass: they are transaction
        // control, allow-listed in guardSession.
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
