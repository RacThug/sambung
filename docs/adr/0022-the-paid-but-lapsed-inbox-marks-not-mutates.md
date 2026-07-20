# ADR-0022: The paid-but-lapsed inbox marks, it does not mutate the ledger

- **Status:** Accepted
- **Date:** 2026-07-20
- **Issue:** #120 (follow-up to #53 / boss fight #4; FR-PAY-2)
- **Relates:** ADR-0018 (the webhook that CREATES this state - records `paid`, never resurrects the booking), ADR-0002 (deleting/marking never destroys the ledger), ADR-0011 (refund stays manual at sandbox), ADR-0010 (owner reads disclose whole rows; public reads clip)

## Context

The webhook (ADR-0018) is late-settlement-safe by construction: if a guest pays
AFTER their hold lapsed (swept to `expired`) or the booking was cancelled, the
guarded confirm matches 0 rows, so the booking is **never resurrected** -
`payment` is recorded `paid` and a loud `WARN` is logged. But a log line is not an
operator workflow: money is captured for a stay that no longer holds its dates, and
nothing tells the owner "refund or re-accommodate this." #120 builds that surface.

The state to detect is precise: `payment.status = paid` AND its
`booking.status IN (expired, cancelled)`. Two questions shape the design: **where**
does the "I've dealt with it" fact live, and **who** may read/clear it.

## Decision

**A nullable `handled_at` marker on `payment`, cleared by a guarded UPDATE that
writes ONLY that column - never `payment.status`, never the booking.**

- **The read** - `GET /payments/lapsed` (authed, owner RLS): paid payments whose
  booking is lapsed and `handled_at IS NULL`, joined to booking/unit/property for
  the amount, guest + contact, dates and names (owner disclosure, the opposite of
  the public clip, ADR-0010). Runs on the owner connection via `JwtAuthGuard` +
  `TenantContext`, and every join is additionally scoped by `booking.tenant_id` -
  the second layer beside RLS (`payment` has no `tenant_id` of its own; its policy
  scopes through the booking join). A reviewer trying to read another tenant's rows
  is refused by both.
- **The marker** - `POST /payments/:id/handle` sets `handled_at = now()`. It is a
  **new fact**, not a mutation of an old one: `payment.status` stays `paid`, the
  booking stays expired/cancelled. The item leaves the inbox because the list's
  predicate excludes handled rows, **not** because any ledger row changed. Nullable,
  so the marker is reversible by construction and destroys nothing.

## Why

**The ledger is sacred (ADR-0002 generalized).** ADR-0002 forbade DELETE from
destroying the booking/payment history; the same principle forbids *clearing an
inbox item* from rewriting it. "Handled" is the owner's acknowledgement, orthogonal
to what the money did and what the calendar says - encoding it by flipping
`payment.status` (to a `refunded`? a `reconciled`?) or resurrecting the booking
would corrupt the ledger to satisfy a UI. So it is stored as an annotation ON the
row it annotates, and the handle write touches exactly one column.

**A column, not a table.** A `payment_reconciliation` table (who/notes/when) is more
flexible but needs its own RLS policy and a join for what is one boolean-ish fact
today. A nullable column inherits `payment`'s existing row-level policy for free (no
RLS migration - the new column is already tenant-isolated) and matches the codebase's
derive-or-annotate-in-place grain (`archived_at`, `hold_expires_at`). A table earns
its place only when there is a second reconciliation fact to store; deferred, not
designed out.

**"Handled" cannot be derived.** The booking is *already* cancelled/expired (that is
the trigger, not the resolution) and the payment *already* `paid`. There is no
existing state that means "the owner has dealt with this" - so unlike availability
or `publishable`, this fact must be stored, not derived.

**Idempotent handle, no new conflict code.** Handling is a guarded UPDATE on the
inbox predicate (paid + lapsed + tenant-owned + unhandled). 0 rows resolves to an
idempotent 200 (already handled - a double-click or stale list is benign) or a 404
(unknown / cross-tenant / not-an-inbox-item, 404-over-403). Nothing here is a domain
409, so ADR-0012's closed conflict set is untouched.

## Consequences

- **The webhook is unchanged.** ADR-0018's late-settlement branch still records
  `paid` + `WARN`; this surface simply reads the resulting state. No coupling.
- **Refund stays manual (ADR-0011).** Handling records "I dealt with it" - it does
  not move money. At sandbox there is no refund API; the owner refunds/re-accommodates
  offline, then marks it.
- **Amount-mismatch is out of scope, deliberately.** The webhook's `amount_mismatch`
  path returns BEFORE any status write, so it leaves the payment `pending` and never
  produces a `paid` row - it is not "captured money on a dead booking" and does not
  belong in a *paid*-but-lapsed inbox. Flagging it is a distinct signal (a
  stuck-pending audit); the issue marked it optional, and it is deferred.
- **Unhandle is a trivial future addition** (the column is nullable) - not exposed in
  v1 because the AC is only "mark handled removes it from the list."
- **Migration 0011** adds `payment.handled_at` (nullable timestamptz); no RLS change.
