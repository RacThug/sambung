# ADR-0018: The payment webhook reconciles on the owner connection, not under RLS

- **Status:** Accepted
- **Date:** 2026-07-20
- **Issue:** #53 (boss fight #4; api-spec §6.2, FR-PAY-2, db-design §4.7)
- **Relates:** ADR-0009 (the cron sweepers, whose owner-connection shape this reuses), ADR-0008 (the pure resolvers, whose resolve-then-RLS shape this deliberately does *not* use), ADR-0015 (the pay step this confirms), ADR-0012 (the closed-set conflict codes — a 200 no-op is not one)

## Context

The Provider (Midtrans sandbox) delivers settlement **at-least-once**, so the
webhook `POST /webhooks/payment/:provider` must be duplicate-proof and race-proof.
It arrives with **no token and no tenant**: it is a machine-to-machine callback,
not a request from a user or a Visitor. Two established patterns in the codebase
could receive such a request, and picking between them shapes the whole handler:

- **Resolve-then-RLS** (ADR-0003/0008): the four public entries read one column on
  the owner connection to find the tenant, mint a principal, then run under RLS.
  Built for a principal that *browses* one tenant's data (a Visitor reading a page,
  a Guest paying).
- **Owner connection** (ADR-0009): the two cron sweepers run cross-tenant on
  `DbService` (RLS-bypassing) because a sweep has no single tenant to scope to.

`payment_event` has RLS enabled (scoped through `booking`, requiring
`booking_id IS NOT NULL`), which a resolver-based handler would have to satisfy;
the owner connection sidesteps it.

## Decision

The webhook runs entirely on the **owner connection** (`DbService`), like the
sweepers — **not** under RLS via a fifth resolver.

The reasoning, because the resolve-then-RLS pattern is otherwise the house style:

### 1. A webhook is a system reconciliation, not an actor browsing as a tenant

The resolve-then-RLS pattern exists for principals that *browse* one tenant's data.
The Provider callback browses nothing — it reports the outcome of money the
**platform** brokered. That is structurally the sweeper category: no principal,
cross to whichever tenant owns the row. `TenantDbService`'s own header comment
routes "work that has no principal / crosses tenants" to the owner connection. The
tenant a payment belongs to is **incidental**, not a scope the caller is confined
to.

### 2. RLS backstops a forgotten `WHERE`; this handler has none

RLS is defense-in-depth against a tenant-scoped list/filter query forgetting its
`tenant_id`. Every statement here is **PK-equality** on a row resolved by its
globally-unique id (`order_id = payment.id`, ADR-0015): resolve the payment, insert
the event, update the payment, update the booking. There is no tenant-scoped
`WHERE` for RLS to guard. The mitigation for the cost below is to keep this handler's
DB surface exactly this small and PK-only.

### 3. A resolver would force a dishonest principal

The Provider is not a Visitor. Minting `{kind:'visitor'}` for it is the lie the
`Principal` union was built to forbid (ADR-0003); adding a `ProviderPrincipal`
would expand boss-fight-#5's security-critical type for a handler that does not
need scoping — and then still have to satisfy `payment_event`'s `booking_id NOT
NULL` policy for zero added safety.

### The idempotency mechanism this connection carries

Inside **one** `db.transaction`: INSERT `payment_event (provider,
provider_event_id)`, then apply the state change. The unique constraint is the
arbiter — a redelivery, or the loser of two concurrent deliveries, hits it and the
service returns **200** having changed nothing. Because the insert and the state
change share the transaction, a crash between them rolls back **both**: the
redelivery is not seen as a duplicate and replays cleanly. The duplicate is caught
**outside** the transaction (Postgres aborts the whole transaction on any error,
25P02), by `pgError(err).constraint === 'payment_event_provider_event_uniq'` — so
`db-error.map.ts` deliberately does **not** map that constraint (a 200 no-op is not
a 409, and ADR-0012's code set is closed to domain conflicts).

`provider_event_id` is **`transaction_id:transaction_status`**, not `transaction_id`
alone: a redelivery of the same transition collapses (the AC), but a real
`pending → settlement` progression does not — the settlement is never mistaken for
a duplicate of the pending that preceded it. Every state UPDATE is additionally
guarded on the current status (`WHERE status='pending_payment'` /
`WHERE status='pending'`), so even a bizarre re-ordering can never un-confirm a paid
booking or resurrect a dead one.

## Consequences

- **Late settlement is safe by construction.** If the hold already lapsed (swept to
  `expired`) or was cancelled, the guarded confirm matches 0 rows — the booking is
  **never resurrected**; `payment` is still recorded `paid`, and a loud `warn` flags
  it for a manual refund. An owner-facing "paid-but-lapsed" inbox is deferred to a
  follow-up. Conversely a **past-TTL-but-still-pending** hold *does* confirm: it
  occupied the nights continuously (the exclusion constraint guaranteed it), so
  confirming is correct — hence the guard is on `status`, not `hold_expires_at`.
- **No raw-body middleware.** Midtrans signs `sha512(order_id + status_code +
  gross_amount + ServerKey)` over parsed fields, not the raw bytes, so the signature
  is recomputed from the zod-validated fields. Signature + parse live behind the
  `PaymentGateway` port (ADR-0015); a `FakePaymentGateway` verifier keeps every test
  off live Midtrans.
- **The verified payload rides on `payment_event.raw_payload`** (migration 0010),
  never on `payment.raw_payload` — which still holds the open Snap session a
  pay-retry reads back (ADR-0015). A `failure` event therefore cannot destroy a
  session the guest still needs.
- **Not throttled tightly.** `@ThrottleSensitive` is deliberately absent: a 429 to a
  provider that treats non-2xx as failure just triggers an endless retry storm
  (ADR-0014). The generous `default` throttler is enough.
- **The FR-NOTIF-1 seam** (confirmation email) runs post-commit and can never fail
  the webhook; the real provider is a follow-up issue, today a logged no-op.
- Two-session reviewed before merge (boss fight): a no-auth write path that mutates
  payments across the RLS boundary.
