# ADR-0026: A statement is guarded where it is issued, not where it is built

- **Date**: 2026-07-21
- **Status**: Accepted
- **Issue**: #75 (boss fight #5, residual from #72/#73)
- **Builds on**: the decision-log rows for #72 (the transaction seam is the service), #74/#76 (RLS fail-closed, one owner of the principal)

## Context

`TenantDbService.run` opens one transaction on the non-owner app role, sets `app.tenant_id`, and runs the caller's callback inside it. A pooled client is checked out for that transaction and returned to the pool at COMMIT. So the hazard the seam exists to prevent is a statement executing **after** its transaction settles: it lands on a recycled connection, inside whatever transaction now owns it, under **another tenant's** GUC. A silent cross-tenant read or write - the exact failure boss fight #5 is about.

#73 guarded this with a `Proxy` over the transaction handle (`guardTx`): every call *through the handle* asserted a liveness flag, so an un-awaited `tx.execute(...)` after settle threw. But it left a residual (#75). Drizzle's query builders are **lazy thenables** - `tx.select().from(x)` issues no SQL; it captures the raw session and runs only when awaited. The handle proxy fires when `tx.select` is *called* (build time, still alive), not when the built query is *awaited* (after settle). So a query built inside the callback and awaited after it returns escaped the guard entirely - same blast radius as #73, a narrower door. Unreachable in the codebase as it stood (nothing built a query it didn't await), but a real hole in a seam whose whole value is being trustworthy.

## Decision

**The liveness guard moves off the handle and onto the session - the single point where every statement is actually issued - and the handle proxy is deleted.**

- `guardSession` wraps the transaction's `session.prepareQuery` in place. Every query the codebase issues (select/insert/update/delete, raw `execute`, `count`) reaches `prepareQuery` when it runs - for the lazy builders, at await time - so one guard there catches a deferred builder when it finally runs, build site or not. (The one path that reaches `prepareQuery` at *build* time, drizzle's explicit `builder.prepare(name)`, is a residual - see Consequences.)
- The liveness flag flips false **synchronously the instant the callback returns**, before Drizzle issues COMMIT. So any statement deferred out of the callback finds a settled transaction and is rejected - even one that fires during the commit round-trip.
- Drizzle closes the transaction with COMMIT/ROLLBACK through that same guarded session *after* the callback returns, when the flag is already false. Those two are **allow-listed** (`isTransactionControl`): they are transaction control, not tenant data, so passing them after settle cannot leak a row, and rejecting the ROLLBACK would even mask the caller's original error.

## Why

**The handle guarded the *build site*; the hazard lives at the *issue site*.** A statement is dangerous when it runs on a recycled connection, and it runs at `prepareQuery`, not at `tx.select`. Guarding where the SQL is issued is guarding the actual hazard; guarding the handle was guarding a proxy for it, and #75 is the proof that proxy was incomplete. This is derive-don't-store applied to a guard: put the check on the thing that matters, not on a stand-in that can drift from it.

**Replace, not augment.** The session guard *subsumes* the handle proxy - the #73 case (`tx.execute` after settle) also funnels through `prepareQuery`, so one guard at the true chokepoint covers both #73 and #75. Two guards for one property is the drift ADR-0012 warns against ("the client cannot tell which layer refused"): a future reader would ask which of them is load-bearing, when the honest answer is only ever the lower one. Deleting the proxy also retires its `Reflect.get`-around-private-fields workaround - guarding one method needs no Proxy at all.

**Safe to mutate the session in place** because it is per-transaction: a pool-backed `db.transaction` mints a fresh `NodePgSession` bound to the checked-out client, so the guard dies with its transaction and never touches the next one on the recycled connection. (This is why `createDb` using a `Pool`, not a single `Client`, is load-bearing here.)

## Consequences

- **This couples to two Drizzle internals** - that a transaction's `session` is the executor, and that `prepareQuery` is the funnel for the queries the codebase issues. That coupling is deliberate and *licensed by a test*: the escape spec builds a query inside `run` and awaits it after, asserting it throws. If a Drizzle upgrade ever routes the lazy-builder execution around `prepareQuery`, that test goes red - the isolation cannot silently reopen. An internal you can reach is safe only when a tripwire watches it; here one does.
- **The guarantee is precise, not total: one path is a documented residual.** Drizzle's explicit reusable-statement API `builder.prepare(name)` calls `prepareQuery` at *build* time (guard passes, alive) and returns a statement whose later `.execute()`/`.all()` go straight to `client.query`, never re-touching `prepareQuery`. A statement prepared inside `run` and executed after settle would escape - the same class as #75, a narrower door. Left open deliberately: it is unreachable (nothing in the codebase calls `.prepare()`), and closing it means wrapping every execution method on the prepared object - the invasive, drizzle-internal-brittle trade this ADR, and #75 before it, declined for the recursive builder proxy. So *every query the codebase issues* is caught; the reusable-prepared-statement API is not - and the comments say exactly that rather than claim "every statement".
- **COMMIT/ROLLBACK are matched by SQL text** (exact `commit`/`rollback`). `run` uses flat joins, never savepoints, so those are the only two statements Drizzle issues after the callback; a nested `tx.transaction(...)` would add savepoint verbs, and this allow-list would need them. Narrow on purpose.
- **A deferred query rejects, and may reject *synchronously*.** Drizzle's thenable calls `execute()` eagerly from `.then`, so `prepareQuery` throwing surfaces as a synchronous throw. A real caller doing `await q` still gets a clean rejection (the `await` adopts it); only a raw `.then` sees the sync throw. The escape test asserts via `try/await/catch` to mirror the caller.
- **Scope is `TenantDbService` only.** The owner connection (`DbService`) - cron sweepers, the payment webhook, the iCal import - is deliberately out of scope: it is RLS-bypassed and system-scoped, so a stray deferred statement there has no cross-tenant blast radius (there is no per-tenant GUC to leak across). It also does not hand out a `run`-style guarded handle. The guarantee this ADR makes is precisely the one that matters: no tenant-scoped statement executes after its tenant transaction settles.
