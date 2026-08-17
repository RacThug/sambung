# ADR-0039: Payment credentials are tenant-scoped; the platform never holds booking funds

- **Date**: 2026-08-17
- **Status**: Proposed - confirms alongside [`docs/prd-product.md`](../prd-product.md) P0-1
  (Midtrans production activation), the step that first makes real credentials exist
- **Builds on**: [ADR-0034](0034-one-identity-many-memberships.md) (tenancy),
  payment-gateway factory (`apps/api/src/payments/payment-gateway.factory.ts`)
- **Supersedes when accepted**: the platform-wide `MIDTRANS_SERVER_KEY` environment
  configuration - the only Midtrans credential the code reads (there is no
  `MIDTRANS_CLIENT_KEY` anywhere: the SPA never embeds snap.js, it follows
  `redirectUrl` per ADR-0015)

## Context

Today the Midtrans gateway reads one `MIDTRANS_SERVER_KEY` from the environment. Every guest
payment, for every property, settles into **one** merchant account — ours. That was the right
shape for a portfolio demo with a sandbox key: one config, one webhook signature, nothing to
provision per tenant.

It is the wrong shape for a product, for a reason that is not technical. If guest money for many
properties lands in our account and we forward it onward, we are functionally holding and routing
third-party funds. In Indonesia that is regulated territory (PJP licensing under BI) — the
business Midtrans and Xendit are licensed to be, and we are not. It also buys us the entire
operational tail that comes with being in the money path: weekly payouts to every owner,
"whose rupiah is this" reconciliation, and sitting in the middle of every refund and chargeback,
sometimes for funds already forwarded.

The industry default agrees. BookandLink's Payment Hub and Hotel Link both have the property
register its **own** gateway account and enter its own keys; their managed offerings (PayKu,
Hotel Link Pay) are optional layers on top, run by entities with the scale and licensing to
carry them. Midtrans accepts individual merchants with KTP + NPWP — no legal entity — so
"every owner has their own account" is a realistic ask even for a four-room guesthouse.

The schema is already half-pointed here: `payment.provider` is a per-row column - though
`'midtrans' | 'xendit'` only by comment and convention today (`schema.ts`), with no enum or
CHECK backing it - and the gateway is constructed behind a factory. Only the credential
source is global.

## Decision

**Gateway credentials live on the tenant, encrypted at rest. Guest funds settle directly to the
owner's own merchant account. Sambung is never in the money path — not at launch, not later.**

Four decisions inside that shape it:

1. **The factory resolves credentials per property, not per process.** `PAYMENT_GATEWAY=fake`
   remains a process-level test switch; real gateway construction takes the tenant's decrypted
   keys. A property with no stored credentials gets a gateway that refuses with a typed
   "payments not configured" error, not a fallback to any shared key — there is no shared key
   to fall back to.

2. **The webhook path identifies the tenant first, verifies the signature second.** Signature
   verification needs the tenant's server key, so the notification URL (or order-id namespace)
   must carry enough to resolve the property before any cryptographic check. A signature that
   verifies under no tenant's key is logged and rejected; it is never retried against other
   tenants' keys beyond the resolved one.

3. **Credentials are encrypted at rest with an app-held key, and never leave the API.** They are
   write-only from the dashboard (owner pastes, can replace, can never read back), excluded from
   every response schema in `packages/shared`, and excluded from logs. RLS scopes the row;
   encryption covers the backup file and the stolen dump.

4. **"No gateway yet" is a supported state, not an error state.** A property can be live —
   taking manual bookings, syncing iCal — before its Midtrans activation clears. The public
   funnel shows availability but disables online checkout with an honest message; the owner's
   setup checklist carries the activation as a step with a guided template.

**Rejected: platform merchant** (all funds through our account, we disburse). Regulatory
exposure without a license, a payout-and-reconciliation operation that is not the product, a
chargeback position we cannot fund, and a per-transaction incentive that contradicts the
commission-free positioning we sell.

**Deferred, not rejected: sub-merchant orchestration.** Xendit's platform/sub-account scheme
(and Midtrans partner equivalents) lets a licensed PJP hold the funds while we orchestrate
owner onboarding in-product — PayKu convenience without the money path. It layers **on top of**
this decision later; nothing here forecloses it, and this ADR is the reason it will layer
cleanly: the tenant, not the platform, is already the merchant of record.

## Why

**The regulatory line is the one line a solo operator cannot afford to discover from the wrong
side.** Every other cost in this decision is recoverable — schema migrations, factory rework,
onboarding friction. Being an unlicensed funds processor is not a bug you patch.

**It converts a money-handling burden into a data-handling one we already carry.** We go from
custodian of funds to custodian of encrypted credentials — a serious duty, but the same *kind*
of duty as the RLS tenancy we already bet on (ADR-0032, ADR-0034), guarded by the same habits.

**It keeps the pricing story honest.** Flat SaaS, no per-booking take, and structurally *unable*
to skim a transaction — the architecture is the proof of the marketing claim.

## Consequences

**What this guarantees.** No pooled funds, no payout runs, no disbursement licensing question.
An owner's money arrives on Midtrans's settlement schedule regardless of anything Sambung does
or fails to do. A breach of one tenant's credentials is bounded to that tenant.

**What this does NOT guarantee, and costs.**

- **Onboarding now includes a third party we don't control.** An owner's go-live for online
  payments waits on Midtrans's review of *their* application. Mitigation is product, not
  architecture: the checklist template, and decision 4's "live without payments" state.
- **There is no platform money dashboard.** We cannot show "all revenue across Sambung" because
  we never see it. Owner-level reporting reads our own `payment` ledger, which remains complete.
- **Key custody is real custody.** Encrypted-at-rest with an app-held key is a decision about
  *our* threat model, and the app key becomes a secret whose loss bricks every tenant's checkout.
  Rotation and backup of that key need a runbook before the first real credential is stored.
- **Refunds still touch us as an actor, not a holder.** Initiating a refund uses the tenant's
  key against the tenant's balance; disputes are between guest, owner, and Midtrans. Support
  will still be asked to explain this. The ToS must say it plainly.
- **Per-tenant webhooks multiply the failure surface.** One owner rotating keys in the Midtrans
  dashboard without updating Sambung breaks *their* checkout silently until surfaced. The
  payment-inbox pattern (ADR-0022) is the right home for "signature failing since …" alerts.
