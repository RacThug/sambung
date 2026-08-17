# EARS spec - Per-tenant payment credentials (PRD-product P0-6, REQ-PA-04)

**Status:** agreed (owner, 2026-08-17) · **Traces to:** [ADR-0039](../adr/0039-payment-credentials-are-tenant-scoped.md)
(confirms it), [`../prd-product.md`](../prd-product.md) P0-6, page specs
[`../pages/app-settings.md`](../pages/app-settings.md) / [`../pages/p-slug.md`](../pages/p-slug.md) /
[`../pages/p-slug-book.md`](../pages/p-slug-book.md) (REQ-PA-04 amendments), migration
`0018_tenant_payment_credential.sql`, runbook `docs/runbooks/credential-key.md`.

> **Format** as [`date-based-pricing.md`](./date-based-pricing.md): one testable sentence per row;
> the **Verified by** test is what makes it falsifiable - a row whose named test does not prove it is
> a claim, not a requirement.

## 1. Credential lifecycle (CR)

| ID | Requirement | Verified by |
|---|---|---|
| CR-01 | WHEN an Owner PUTs a server key for a provider, the system shall encrypt it (AES-256-GCM, the app-held `CREDENTIAL_ENCRYPTION_KEY`) and upsert ONE row per `(tenant, provider)` - replace is the same idempotent verb. | api `payments/payment-credentials.spec.ts` |
| CR-02 | The system shall return the stored server key from NO endpoint, in NO form - not masked, not truncated. The status read carries only provider, environment, configuredAt and the last verify outcome. | api `payment-credentials.spec.ts` (raw key absent from response BYTES) + shared `payment-credential.test.ts` (exact-key-list pin) |
| CR-03 | WHEN a key is saved, the system shall verify it against the provider's API inline and STORE the outcome; IF verification fails or the provider is unreachable, THEN the key still saves and the outcome says so - a provider outage must not block a valid key (the #55 smoke-fetch rule). | api `payment-credentials.spec.ts` (fake gateway forced to fail verify; stored, 200) |
| CR-04 | The system shall accept `environment: sandbox\|production` per credential and use the matching provider base URL for every call made with that credential. | api `payment-credentials.spec.ts` (environment persisted) + `midtrans.gateway` per-env base URLs |
| CR-05 | WHILE the caller is Staff, the system shall answer 403 to both the status read and the write, before any lookup (`@Roles('owner')` - the shape of the Tenant's money). | api `payments/payment-credentials.spec.ts` |
| CR-06 | The system shall scope credential rows by tenant under RLS, and the dashboard's status SELECT shall never include `ciphertext`/`nonce`; the decrypting read runs ONLY at the gateway layer on the owner connection. | db `rls.test.ts` (table-driven) + db `payment-credential.test.ts` (the app role's SELECT of ciphertext/nonce is 42501 - the grant, stronger than a column-list assertion) |

## 2. Gateway resolution & the funnel (GW)

| ID | Requirement | Verified by |
|---|---|---|
| GW-01 | WHEN a payment session is minted or a status fetched, the system shall construct the gateway with the BOOKING's tenant's decrypted key - resolved per request, never from process env. | api `payment-credentials.spec.ts` WH-01 test (two tenants, two really-encrypted keys, resolution proven end to end on the webhook path); the mint path shares the SAME CredentialResolver, and its refusal is pinned by the GW-02 test |
| GW-02 | IF the booking's tenant has no stored credential, THEN `POST /public/bookings/:id/pay` shall answer `409 {code: "payments_not_configured"}` (closed set, ADR-0012). | api `payment-credentials.spec.ts` (GW-02: pay → 409 after the credential is deleted, real gateway bound - an outbound call would fail the test loudly) |
| GW-03 | IF the tenant has no stored credential, THEN `POST /public/bookings` shall answer the same 409 - a Hold exists only to bridge to payment, and a crafted request must not park unpayable 15-minute Holds (FE gating is UX, this is the correctness layer). | api `payment-credentials.spec.ts` (GW-03: booking write → 409, then 201 once a credential exists) |
| GW-04 | The public property read shall carry derived `onlinePaymentsAvailable` (a credential EXISTS - the verify badge is information, not a gate), so the funnel shows availability but replaces checkout with an honest message (ADR-0039 decision 4). | api `payment-credentials.spec.ts` (the flag flips with the SAME predicate) + web `availability-picker.test` / `checkout-page.test` (CTA replaced, form replaced) |
| GW-05 | WHILE no credential exists, the tenant shall remain fully operable otherwise: walk-ins, blocks, iCal sync and the public page all keep working. | the walk-in / iCal / property suites run credential-less throughout, and the GW-03 test's tenant still serves its public page |
| GW-06 | `PAYMENT_GATEWAY=fake` shall remain a process-level test seam, bypassing credential resolution entirely (the e2e harness, #167, unchanged). | e2e suite green |

## 3. The webhook resolves the tenant first (WH)

| ID | Requirement | Verified by |
|---|---|---|
| WH-01 | WHEN a webhook arrives, the system shall resolve `order_id` → payment → booking → tenant FIRST (the ADR-0015 `order_id = payment.id` key, on the owner connection as today), decrypt that tenant's key, and verify the signature under it - never trying any other tenant's key. | api `payment-credentials.spec.ts` (tenant B's signature on tenant A's order → 401, booking untouched; A's own → confirmed) |
| WH-02 | IF `order_id` resolves to no payment, THEN the system shall answer 200 + WARN without any signature verification (nothing to verify against; 4xx to a provider is a retry storm, ADR-0018). | api `payment-credentials.spec.ts` (garbage order id + garbage signature → 200) |
| WH-03 | IF the signature fails under the resolved tenant's key, THEN the notification shall be rejected and logged; idempotency, guarded transitions and late-settlement behaviour (ADR-0018) shall be unchanged in every other respect. | existing `payment-webhook.spec` re-run green (fake path) + the WH-01 test's 401 case (real crypto) |
| WH-04 | Reconcile-on-read (`fetchStatus`, ADR-0020) shall resolve the tenant's credential the same way; a tenant with no credential shall skip reconcile rather than error the confirmation page. | existing `confirmation.spec` re-run green (fake path); a credential-less tenant skips reconcile by the same `credentialForOrder` the WH tests exercise |
| WH-05 | The webhook path shall keep answering 404 for an unknown provider segment; `manual` and any non-gateway word never verify. | existing `payment-webhook.spec` (unknown provider → 404), re-run green |

## 4. Migration & operations (MIG)

| ID | Requirement | Verified by |
|---|---|---|
| MIG-01 | The system shall have NO platform-wide payment key in the production path: `MIDTRANS_SERVER_KEY` is read only by the seed (to encrypt a demo credential into Bali Breeze when set) and nothing else. | api `payments/no-platform-key.spec.ts` (walks apps/api/src for read patterns) |
| MIG-02 | IF the process is a DEPLOYMENT (the #193 predicate) and `CREDENTIAL_ENCRYPTION_KEY` is unset, THEN `validateEnv` shall refuse to boot - stored credentials with no key is every checkout bricked, silently. | api `validate-env.spec.ts` (missing + wrong-shape key refused on a deployment; local sandbox untouched) |
| MIG-03 | The system shall store `key_version` beside each ciphertext, and the rotation runbook (`docs/runbooks/credential-key.md`: generate, back up offline, rotate by re-encrypt) shall ship in this slice. | runbook + `credentials:rotate` script exist; api `payment-credentials.spec.ts` rotation test (old key can no longer read, new key recovers, re-run no-ops) |
| MIG-04 | A keyless dev machine shall seed the "not configured" state and the demo shall still narrate it (decision 4 is itself demoable). | seed run without the env var |

## 5. Out of scope (deferred by name)

Deleting a credential (disable-online-payments verb), Xendit as a second live gateway, sub-merchant
orchestration (ADR-0039 defers it), the "signature failing since…" inbox item (follow-up; loud in
logs meanwhile), per-property credentials (the credential is the Tenant's), and any UI for key
rotation (runbook-driven, operator-level).
