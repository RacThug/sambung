# Research - Does a Midtrans Sandbox key still start with `SB-`?

**Asked:** 2026-08-19 · **For:** [`../../packages/shared/src/payment-credential.ts`](../../packages/shared/src/payment-credential.ts)
(REQ-PA-04, [ADR-0039](../adr/0039-payment-credentials-are-tenant-scoped.md)) · **Question:** the settings form
told owners to paste a key shaped `SB-Mid-server-…`. Is that still what Midtrans hands out?

> **How to read this.** The answer here is **no**, and it is the rare case where a **primary**
> observation contradicts the platform's own **primary** documentation. Both are cited below. When a
> vendor's docs and a vendor's product disagree, the product wins - but only for what was actually
> observed, which is one account on one date.

## 1. What we observed

| | |
|---|---|
| **When** | 2026-08-19 |
| **Where** | Midtrans merchant dashboard, Settings → Access Keys, sidebar reading **Environment: Sandbox** |
| **Account** | the project owner's own (Merchant ID redacted; it is a sandbox account) |
| **Client Key** | `Mid-client-…` |
| **Server Key** | `Mid-server-…` |

No `SB-` prefix on either, in an environment the dashboard itself labels Sandbox. **Confidence:
primary** - a screenshot of the issuing surface, not a retelling.

## 2. What the docs say

| Claim | Source | Confidence |
|---|---|---|
| A Sandbox server key is shaped `SB-Mid-server-abc123cde456` | [API Authorization & Headers](https://docs.midtrans.com/docs/api-authorization-headers) | primary (and **contradicted** by §1) |
| Sandbox and Production keys are different values and must not be swapped | [Switching to Production Mode](https://docs.midtrans.com/docs/switching-to-production-mode) | primary (still true) |
| Environment is switched from the top-left dropdown in the dashboard | [Help Center 204415174](https://support.midtrans.com/hc/en-us/articles/204415174-How-do-I-migrate-my-account-from-Sandbox-to-Production-) | primary (still true) |

Only the **prefix** claim is stale. Everything else about the two-environment model holds, including
the part that matters most: a key is valid for exactly one environment, and the two are not
interchangeable.

## 3. Why this cost us nothing

The wire contract never trusted the shape:

```ts
serverKey: z.string().trim().min(8).max(256)
```

A prefix regex would have **refused a valid sandbox key** at the boundary, and the owner would have had
no way to proceed and no way to find out why - the key in their hand would have looked wrong to us and
right to Midtrans. Instead, validity is decided by [`midtrans.gateway.ts`](../../apps/api/src/payments/midtrans.gateway.ts)'s
verify-on-save probe (EARS CR-03): GET the status of an order that cannot exist, against the environment
the credential *names*. A valid key answers 404, an invalid one 401. That test asks the only authority
there is, and it does not care what the key looks like.

**The generalisable rule:** validate that a third-party credential is *present and sane*; let the third
party decide whether it is *correct*. A format assertion about someone else's system is a guess with an
expiry date - this one expired without an announcement.

## 4. What changed as a result

- The Settings → Payments placeholder, which read `SB-Mid-server-…` and would have sent an owner
  hunting through the wrong dashboard environment for a key that does not exist there.
- The comment on `savePaymentCredentialRequestSchema`, which cited the old shape as current.
- **No validation changed**, because there was none to change. That was the point.

## 5. Caveats and what would change this answer

- **n = 1.** One account, one date. We cannot tell from a single dashboard whether the prefix was
  dropped platform-wide, dropped for accounts created after some date, or never applied to this account
  type. Do not write "Midtrans removed the SB- prefix" anywhere it reads as a platform fact.
- A key that *does* carry `SB-` is therefore still perfectly plausible, and must keep working. It does:
  nothing in the code inspects the prefix.
- **The environment field still matters.** `environment` is stored per credential and selects the host
  (`app.sandbox.midtrans.com` vs `app.midtrans.com`). Since the two key formats are now
  indistinguishable by eye, the owner's environment choice on the form is the *only* thing separating a
  test transaction from a real charge - the verify-on-save probe is what catches a mismatch, and it is
  no longer backstopped by an obvious prefix. Worth remembering when P0-1 activates production.
- Midtrans updating its docs to match its product would upgrade §1 from "observed" to "documented", and
  this note could then shrink to a line.
