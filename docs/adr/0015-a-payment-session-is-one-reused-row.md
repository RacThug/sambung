# ADR-0015: A payment session is one reused row, addressed by its own id

- **Date**: 2026-07-19
- **Status**: Accepted
- **Issue**: #52 (M3, FR-PAY-1)
- **Builds on**: api-spec §6.1 (`POST /public/bookings/:id/pay`, "one `payment` row per booking attempt cycle"), [ADR-0008](0008-a-public-resolver-resolves-it-does-not-judge.md) (a public resolver resolves, it does not judge), [ADR-0009](0009-a-hold-is-cleared-by-a-sweep-at-two-scopes.md) (the opportunistic in-txn hold sweep), [ADR-0012](0012-a-409-carries-a-code-not-a-sentence.md) (a 409 carries a code)
- **Sets up**: #53 (the idempotent webhook → `confirmed`), #54 (the confirmation page's reconcile-on-read)

## Context

`POST /public/bookings/:id/pay` turns a live Hold into a Provider (Midtrans sandbox) checkout session and hands the Guest a redirect. It is the first place Sambung talks to a payment Provider, and the shape it settles now is the shape #53's webhook and #54's confirmation read must both address. Three forces pull on it:

- **The Guest retries.** A payment page is abandoned, re-opened, double-clicked. api-spec §6.1 says calling twice "re-uses the open payment session (idempotent-ish: one `payment` row per booking attempt cycle)". So "pay again" must never mean "charge twice" or "mint a second order the Provider now tracks separately".
- **The Provider is at-least-once and comes back by a key.** #53's webhook is delivered by Midtrans keyed on an `order_id` the Provider echoes. Whatever we send as `order_id` at session-create is the join key the webhook resolves the booking by. Choosing it here is choosing #53's lookup.
- **The `payment` table is Provider-agnostic; a Snap token is not.** The typed columns (`amount_idr`, `status`, `provider`, `provider_ref`) describe *a payment* in any Provider's terms. Midtrans's Snap `token` and `redirectUrl` describe *this Provider's session* - vocabulary that must not calcify into a column, or a second Provider (or a schema reader) inherits Midtrans's shape as if it were the domain's.

And the funnel's entry is, as ever, cross-tenant: a Guest has no token, so nothing has scoped the request to a tenant before the booking id in the path resolves one.

## Decision

**A booking has at most one open payment. The pay endpoint reuses it or mints it - and when it mints, the row's own id is the Provider order id. The Provider's session envelope lives in the row's `raw_payload` jsonb, never in a typed column. The amount is snapshotted at mint.**

The whole endpoint is one transaction, under the tenant the booking id resolves to:

1. **Resolve, don't judge.** `PublicScope.enterFromBookingId(id)` reads one column - `booking.tenant_id` - on the owner connection, 404s an id that addresses no booking, and mints a Visitor scoped to that tenant. It judges the booking's *status* nowhere (ADR-0008); the payability judgement is this write's to make, below. It is the third member of the resolver family (slug → unit id → booking id). The `payment` RLS policy scopes through `booking.tenant_id`, so once the Visitor is minted the row's insert and read pass `WITH CHECK`/`USING` with no special connection.

2. **Sweep, then read one status.** The opportunistic hold sweep (ADR-0009) flips this unit's lapsed-but-unswept holds to `expired` *before* the status is read, so "the hold expired" and "the status is wrong" become a single post-sweep check. If `booking.status ≠ pending_payment` → `409 booking_not_payable { status }` (a new `conflictCodeSchema` slug, ADR-0012), the terminal status carried as data.

3. **Reuse an open session, or mint one.** If a `payment` row for this booking already sits at `status = 'pending'`, its stored session is returned unchanged - no second Provider call, no second order. Otherwise: INSERT the row (`status='pending'`, `amount_idr`, `provider='midtrans'`), use **`payment.id` as the Provider `order_id`** (persisted to `provider_ref`), call the gateway, and store the returned `{ token, redirectUrl }` in `raw_payload`. The response is `{ provider, token, redirectUrl, amountIdr, deposit }`, `deposit = depositPct < 100`.

**`amountIdr = (totalPriceIdr × depositPct) / 100`, in BigInt, floored** (invariant #6 - no float touches money; the truncation never overcharges the Deposit). `depositPct` is the Property's `deposit_pct smallint` (1-100, default 100), snapshotted onto the payment row at mint - so an owner editing the Deposit mid-cycle can never change what an already-open session charges.

**The Provider is a port.** `PaymentGateway.createSession(...) → { token, redirectUrl }` is an interface; `MidtransGateway` is the only adapter (Snap sandbox over `fetch`, keys from `ConfigService`, fail-loud if unconfigured); tests bind a `FakePaymentGateway` via the DI token. No test ever reaches live Midtrans, and nothing outside the adapter knows Snap's request shape.

## Why

**One open row is what makes retry safe by construction, not by luck.** The alternative - a fresh `payment` row (and a fresh Provider order) per pay click - would leave a booking with a fan of half-open orders the webhook then has to reconcile into one truth. Keeping exactly one open row means the idempotency is a `WHERE status='pending'` lookup, and the "attempt cycle" api-spec §6.1 names is just the life of that row: it ends when the row settles (`paid`/`failed`) or the hold sweeps the booking to `expired`, and only then can a new one be minted.

**`payment.id` as `order_id` decouples the Provider key from the booking and pre-wires #53.** The order id must be globally unique forever (a Provider never lets one be reused). The payment row's uuid is that, for free, and it points the webhook straight at the row it must mutate - `WHERE payment.id = order_id` - without a second lookup table. Using `booking.id` instead would collapse if a booking ever needed two lifetime attempts; using a minted string would add an identity to store and dedupe that the row already has.

**A Snap token in `raw_payload`, not a column, keeps the table honest.** `raw_payload` exists precisely to hold the Provider's shape (§6.2 stores the webhook's raw payload there too); the session envelope is the same kind of thing, one step earlier. A `snap_token`/`redirect_url` column pair would read as domain fields while meaning "Midtrans, specifically" - the enum-drift smell (api-spec §8.6) in table form. The cost is that `raw_payload` carries the session before settlement and the webhook payload after; acceptable, because once the row is `paid` the session is spent and pay 409s anyway, so the two never need to coexist.

**The amount is snapshotted for the same reason a booking snapshots its price.** The Deposit percent is a mutable Property setting; the charge a Guest is looking at must not shift under them because the owner edited a field in another tab. Freezing `amount_idr` at mint is the payment-row analogue of `booking.total_price_idr` (api-spec §4.6 - "a booking snapshots its own `totalPriceIdr`").

**A port, tested by a fake, is the only way the AC ("tests run without live Midtrans") is honestly met.** An env flag that swaps in a stub is a second code path that can ship to prod; a DI binding overridden in the test module cannot. Raw `fetch` over the `midtrans-client` SDK keeps the adapter small enough to be fully replaced by the fake and honours invariant #8's "flag heavy deps" - #53's signature verification can re-evaluate if the SDK earns its place there.

## Consequences

- **New migration `0008`** adds `property.deposit_pct smallint not null default 100` + `CHECK (deposit_pct between 1 and 100)`. `depositPct` joins the property create/update/response contract and the property edit page; no other table changes (the session reuses `raw_payload`).
- **A new `payments` module** (`apps/api/src/payments/`) owns `POST /public/bookings/:id/pay`, the `PaymentGateway` port + `MidtransGateway` + `FakePaymentGateway`, and the config for Midtrans keys. #53 (webhook) and #54 (reconcile) land here too - the module boss fight #4 lives in.
- **`booking_not_payable` joins `conflictCodeSchema`** (detail `{ status }`) with its factory and `describeConflict` copy - the compiler forces all three together (ADR-0012).
- **`enterFromBookingId` is the third public resolver.** `PublicScope` stays the one class that crosses tenants for an unauthenticated request; its surface grows by one column-read, not one judgement.
- **The Guest's return is not the source of truth.** Pay ends at the Snap redirect; confirmation waits on #53's webhook. #54 adds reconcile-on-read as the backstop for a lost webhook. `.env.example` gains `MIDTRANS_SERVER_KEY`/`MIDTRANS_CLIENT_KEY` (sandbox), and a fresh clone runs the whole suite green without them because the fake is the test binding.
