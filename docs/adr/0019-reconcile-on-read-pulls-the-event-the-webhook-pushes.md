# ADR-0019: Reconcile-on-read pulls the same event the webhook pushes

- **Status:** Accepted
- **Date:** 2026-07-20
- **Issue:** #54 (M3; api-spec §6.3, page-spec §3.3, FR-NOTIF-1/2, risk R3)
- **Relates:** ADR-0018 (the idempotent webhook whose transaction this reuses), ADR-0008 (the pure resolvers — `enterFromBookingId` is the entry), ADR-0009 (the opportunistic hold-sweep this runs on read), ADR-0015 (the pay step this confirms)

## Context

The confirmation page `GET /public/bookings/:id` is where the guest lands after
paying. A payment provider delivers settlement **at-least-once but not
guaranteed** — a webhook can be lost. Risk R3's mitigation is that the page
**reconciles on read**: if the booking is still pending, the server asks the
Provider directly, so a lost webhook still confirms here.

That creates a **second** path to `confirmed`, alongside the webhook (#53). Two
things must not break:

1. The read-can't-disagree-with-write spine of this codebase — there must be **one**
   definition of "processed", not two that drift.
2. FR-NOTIF-1's confirmation email must fire **exactly once** per confirmation,
   even though two paths (push + pull) and duplicate deliveries can all race.

## Decision

**Reconcile-on-read PULLS the same event the webhook PUSHES, through the identical
idempotent transition.**

- The `PaymentGateway` port gains `fetchStatus(orderId)`, which returns the **same**
  `ParsedPaymentEvent` a webhook yields (Midtrans's Get-Status response is signed
  identically, so it reuses `verifyAndParse` — one parser, no second copy).
- `PaymentWebhookService.reconcile(orderId)` feeds that event through the **exact**
  transaction `handle` uses: INSERT `payment_event (provider, provider_event_id)`,
  then the status-guarded confirm. It runs on the **owner connection** like the
  webhook (ADR-0018): same system reconciliation, PK-targeted by `order_id`, no
  principal — **not** a sixth resolve-then-RLS entry.
- Whichever path arrives first wins; the loser (a redelivery, the concurrent loser,
  or the other path) hits the `payment_event` unique constraint and no-ops **before**
  `afterCommit`. So the confirm — and its email — happens once, by construction.

**The confirmation email is a best-effort post-commit seam behind a `Mailer` port.**
`afterCommit` fires `notifyConfirmed` **only** when the status-guarded
`pending_payment → confirmed` UPDATE actually flipped a row (`confirmed: true`) —
which is true for exactly one event across every delivery path. `MAILER` is bound to
`LogMailer` (renders + logs; **no paid provider**, invariant #8); a real Resend/SMTP
adapter is a one-line rebind with zero call-site change. `NotificationsService`
catches and never rethrows: a bounced email cannot undo a confirmed booking or fail
the webhook the provider is retrying.

**The read's shape.** `enterFromBookingId` resolves the tenant (unknown id → 404 at
the door, ADR-0008); reconcile runs on the owner connection; then an **opportunistic
hold-sweep** (ADR-0009) runs *after* reconcile, so a booking the reconcile just
confirmed is untouched (the sweep is `status='pending_payment'`-guarded) while an
unpaid, past-TTL hold flips to `expired` immediately — the page tells the truth
without waiting for the 5-min cron. The view itself is read under the Visitor's RLS
scope. Every reconcile step is best-effort: a provider hiccup must render the DB's
current state, not a 500.

**wa.me (FR-NOTIF-2).** The response's `waLink` targets the **guest's own** WhatsApp
number (the channel they gave) with a prefilled summary. It is a server-built string,
so retargeting to a stored host number later is a zero-shape change.

### Alternatives rejected

- **Confirm directly under the Visitor RLS scope on read** (a second write-to-confirmed
  path). It would drift from the webhook's guarantees and could double-fire the email;
  it also re-introduces a tenant-scoped confirm where ADR-0018 deliberately kept the
  reconciliation PK-only and principal-free.
- **A real email provider now.** Needs credentials and a recurring cost (invariant #8).
  The `Mailer` port + `LogMailer` is a real, unit-testable seam today; the provider is a
  follow-up swap, not a shape change.

## Consequences

- "Email exactly once per confirmation, idempotent under duplicate webhooks" is true
  **by construction** (the unique constraint + the status-guarded confirm), proven on
  real Postgres in `confirmation.spec` and `payment-webhook.spec`.
- `afterCommit`/`notifyConfirmed` are now **awaited** (were fire-and-forget) so the
  outcome is deterministic and testable; because the notifier is best-effort, awaiting a
  log-backed sender can neither fail the webhook nor delay it noticeably.
- `fetchStatus` is bound by the fake gateway in tests (a per-order status map), so no
  suite reaches live Midtrans; the confirmation email is asserted against a recording
  fake mailer, not a log grep.
- New env `MIDTRANS_API_BASE_URL` (Core-API base for Get-Status); unset is fine for
  dev/test.
