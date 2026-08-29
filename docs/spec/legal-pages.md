# EARS spec - Legal & trust pages (PRD-product P0-5, REQ-TR-01)

**Status:** draft (owner decisions taken 2026-08-29 - hybrid scope, *perorangan now / PT later*,
ID + EN) · **Traces to:** [`../prd-product.md`](../prd-product.md) P0-5, ADR-0041 (proposed - *a
cancellation policy is the host's promise, not the platform's*), api-spec §4.3 + §4.7 amendments,
page specs [`../pages/p-slug.md`](../pages/p-slug.md) / [`../pages/p-slug-book.md`](../pages/p-slug-book.md)
/ [`../pages/app-properties-propertyId.md`](../pages/app-properties-propertyId.md) /
[`../pages/register.md`](../pages/register.md), [`../sitemap.md`](../sitemap.md) §2, shared contract
`packages/shared/src/property.ts` + `public-property.ts`, **migration 0019**.

> **Format** as [`honesty-sync-ux.md`](./honesty-sync-ux.md): one testable sentence per row; the
> **Verified by** test is what makes it falsifiable - a row whose named test does not prove it is a
> claim, not a requirement.

**The gap this closes.** There is no `/terms`, no `/privacy`, and no word anywhere in the funnel about
what happens to a guest's money if they cancel. A guest today pays a deposit (ADR-0015) on the strength
of a page that never states a single condition. That is the trust gap; the legal gap is its twin, because
Midtrans's merchant review asks for publicly reachable terms, privacy and refund policies before a
production account exists at all - so this slice is also the cheapest thing that moves P0-1.

**The distinction the whole slice turns on.** There are **two documents, two authors, two audiences**,
and conflating them is the failure mode:

| | Platform terms & privacy | Cancellation policy |
|---|---|---|
| Between | Sambung ↔ **Owner** (a SaaS relationship) | **Host** ↔ Guest (an accommodation contract) |
| Written by | us, once, statically | the owner, per Property |
| Read by | the owner at signup, a merchant reviewer | the guest, before paying |

[ADR-0039](../adr/0039-payment-credentials-are-tenant-scoped.md) is what forces the split rather than
merely suggesting it: guest money settles into the **owner's** merchant account and Sambung is never in
the money path. **A system that cannot execute a refund must not be the party promising one.** So Sambung
states its own terms and stores - verbatim, untranslated, unautomated - the host's.

---

## 1. The platform pages (PL)

| ID | Requirement | Verified by |
|---|---|---|
| PL-01 | The system shall serve `/legal/terms`, `/legal/privacy` and `/legal/refund` as public routes, documented in sitemap §2. | existing web `sitemap.guard.test.ts` (ADR-0036 - an undocumented route fails the guard, which is how #213's route was caught before review) |
| PL-02 | The pages shall render from bundled content with NO API call and NO database read: a legal page must still render when the API is down, because it is the page a merchant reviewer opens and the page a dispute cites. | web `legal-page.test.tsx` - renders with no MSW handlers registered, so any fetch would fail the test |
| PL-03 | The Indonesian text shall be AUTHORITATIVE and the English a courtesy translation, stated in that wording on each page. An unauthored locale (ZH) shall fall back to **English**, not Indonesian - a reader who chose ZH is likelier to read EN than ID. | web `legal-page.test.tsx` (locale `id` → ID body; `en` and `zh` → EN body + the "Indonesian version prevails" line) |
| PL-04 | The legal identity - entity name, address, contact email, effective date, version - shall live in ONE module read by all three pages, so the switch from *perorangan* to PT Perorangan is one edit, not a sweep of three prose files. | web `legal-page.test.tsx` (all three pages assert the SAME entity string, sourced from the constant) |
| PL-05 | Each page shall display its effective date and version, so a later amendment is legible rather than silent. | web `legal-page.test.tsx` |
| PL-06 | The legal prose shall NOT enter the i18n message catalogue: catalogues are UI strings, keyed and parity-checked across three locales, and long two-locale prose there would either break that parity or force a fabricated ZH legal translation. Content modules per locale instead, lazily loaded. | existing web `i18n/messages/catalog.test.ts` stays green with no ZH legal keys added; `check-bundle.mjs` shows legal content in its own chunk, not the funnel's |
| PL-07 | The pages shall be reachable with NO authentication and NO session, from a cold deep link. | e2e `funnel/legal-pages.spec.ts` (opened in a fresh context with no storage state) |
| PL-08 | `/legal/refund` shall state plainly that (a) Sambung charges the owner nothing today, so there is no subscription refund to make, and (b) **guest booking refunds are the host's**, governed by the property's own policy - with a pointer to where that appears. A refund page silent on the second half would be the exact conflation this slice exists to prevent. | web `legal-page.test.tsx` (both halves asserted) |
| PL-09 | `/legal/privacy` shall name what is actually true of this system rather than boilerplate: the only cookie is the first-party refresh session cookie (strictly necessary - no consent banner is required, and none is shown), locale is a `localStorage` preference, there is **no third-party analytics or tracking script**, and the named processors are Midtrans (payments), Resend (email) and the object store (photos). | web `legal-page.test.tsx` (names the three processors and the no-tracking claim) + `no-trackers.test.ts` - a tripwire walking `apps/web/src` + `index.html` for analytics snippets, so the *claim* fails the build if it ever stops being true |
| PL-10 | `/legal/privacy` shall state the UU PDP (UU 27/2022) roles honestly: Sambung is **controller** for owner account data and **processor** for guest booking data handled on the owner's behalf. | web `legal-page.test.tsx` |

## 2. Reachability (RE)

*A legal page nobody can reach is theatre - the argument ADR-0040 made about a red pill on a page the
owner never opens.*

| ID | Requirement | Verified by |
|---|---|---|
| RE-01 | A footer carrying the three links shall render on the public funnel and the auth pages, from the SAME shell that already owns that split (`PublicShell`), and shall render nothing under `/app` or `/invite`. | web `public-shell.test.tsx` (present on `/p/:slug`, `/login`; absent on `/app/calendar`, `/invite/:token`) |
| RE-02 | The dashboard shall also link the terms - the owner is the counterparty to them - from the settings page, not from a footer the sidebar shell does not have. | web `settings-page.test.tsx` |
| RE-03 | `/register` shall state, adjacent to the submit button, that creating an account agrees to the Terms and Privacy Policy, with both linked. The links shall open in a new tab so a half-filled form is not lost to a navigation. | web `register-page.test.tsx` (the copy, both `href`s, and `target="_blank"` + `rel="noreferrer"`) |
| RE-04 | The footer links shall be plain in-SPA navigations, adding no new fetch and no new dependency to the funnel bundle. | existing web `check-bundle.mjs` budget stays green |

## 3. The per-property cancellation policy - contract & schema (CP)

| ID | Requirement | Verified by |
|---|---|---|
| CP-01 | `property` shall gain `cancellation_policy text` (nullable, no default) in migration 0019. NULL means "the host has not stated one" - a distinct fact from an empty string, which normalizes to NULL at the boundary. | db `schema.test.ts` (column exists, nullable) + `db:generate` reports no drift after the migration |
| CP-02 | The field shall be accepted on create and PATCH through the existing `clearableText(2000)` shape - absent leaves it alone, null or blank clears it - and returned on `PropertyResponse` as `string \| null`. | api `properties-crud.spec.ts` (set, edit, clear-with-null, clear-with-blank, and >2000 chars → 400) |
| CP-03 | The policy shall be FREE TEXT, not structured rules (no "X% up to N days"). Structured rules imply an automated refund, and under ADR-0039 Sambung has no access to the money to execute one; encoding a schedule we cannot honour is a promise the system cannot keep. | no test - a design constraint whose evidence is the ABSENCE of a rules schema. Stated here so a later "just add a percentage field" reopens the argument rather than sliding past it |
| CP-04 | The field shall NOT enter `publishable` and shall NOT gate the public page (ADR-0004: a public URL is an address, not a view of state). A missing policy makes the funnel say more, never 404. | api `properties-crud.spec.ts` (a property with no policy stays `publishable: true`) + existing `public-properties.spec.ts` |
| CP-05 | The public payload (§4.7) shall carry `cancellationPolicy`. Adding a response field is lenient by ADR-0031 and breaks no existing consumer; it rides beside `depositPct` for the same reason that one does - a payment term the guest meets before the redirect, not after. | api `public-properties.spec.ts` (present when set, `null` when not, parsed through `publicPropertyResponseSchema` so a missing key fails at the boundary) |
| CP-06 | The policy shall be rendered as TEXT, never as HTML or markdown: escaped by React, line breaks preserved by CSS (`whitespace-pre-line`), no `dangerouslySetInnerHTML` anywhere in its path. It is owner-authored free text on an unauthenticated page - the one XSS surface this slice creates. | web `property-page.test.tsx` (a policy containing `<script>` and `<b>` renders as literal characters) + api `public-properties.spec.ts` (stored and returned byte-identical - the API does not sanitize, because escaping at render is the correct layer and stripping at write would silently corrupt an owner's punctuation) |
| CP-07 | The stored text shall be presented VERBATIM in every locale - the funnel's three languages translate the LABEL around it, never the host's words (ADR-0024: the funnel speaks three languages, the wire speaks one). | web `funnel-i18n.test.tsx` (the label changes with locale, the body does not) |

## 4. What the guest is told (GU)

| ID | Requirement | Verified by |
|---|---|---|
| GU-01 | The checkout shall show the policy BEFORE the pay CTA, on the same screen as the amount due. After payment is too late for a condition to be a condition. | web `checkout-page.test.tsx` (the policy block precedes the submit button in DOM order) |
| GU-02 | The property page shall show it too, near the picker, so it is readable before a date is chosen rather than only at the last step. | web `property-page.test.tsx` |
| GU-03 | IF no policy is stated, THEN both surfaces shall SAY so - "this host has not stated a cancellation policy; ask before you book" - and never fall silent. Silence at a payment step is indistinguishable from a generous policy, which is the precise false comfort UX-01a of the sync spec rejected on the calendar. | web `checkout-page.test.tsx` + `property-page.test.tsx` (the null case asserts the sentence, not merely the absence of a block) |
| GU-04 | The guest confirmation email shall carry the policy verbatim (or, when none is stated, the same honest line), because the moment it becomes binding is the moment the guest needs their own copy. | api `confirmation-email.spec.ts` (a policy appears in the guest text body; the null case carries the honest line; the OWNER copy does not repeat it - the owner wrote it) |
| GU-05 | The email shall carry the policy in its plain-text body, and - if an html body is sent - escaped there. | api `confirmation-email.spec.ts` (a policy containing `<script>` is escaped in html and literal in text) |

## 5. What the owner does (OW)

| ID | Requirement | Verified by |
|---|---|---|
| OW-01 | The Property workbench shall edit the policy in the PAYMENT-terms group beside the deposit percentage, not in the location group - it is a fact about the money, and ADR-0028 established that where a field is placed is part of what it means. | web `property-edit-form.test.tsx` (the field is inside the payment fieldset) |
| OW-02 | WHEN the field is empty, the workbench shall NUDGE ("guests are told you have not stated one") - a visible consequence, not a validation error and not a publish gate (CP-04). | web `property-edit-form.test.tsx` (nudge on empty, gone once set, and saving with it empty still succeeds) |
| OW-03 | This slice shall add no dashboard i18n keys: the dashboard is English (ADR-0024). The three funnel locales gain only the LABEL keys of GU-01/02/03. | existing `catalog.test.ts` (three-locale parity) + no `useTranslation` in the touched dashboard files |
| OW-04 | The owner shall set a policy and see it reach the guest, end to end against real rows: edit on the workbench → visible on `/p/:slug` and at checkout. | e2e `funnel/cancellation-policy.spec.ts` |

## 6. Isolation (invariant #2)

| ID | Requirement | Verified by |
|---|---|---|
| ISO-01 | The policy shall ride `property`'s existing RLS policies - no new table, no new policy, no new axis. It is a column on a table whose isolation is already proven on both axes (tenant + staff-assigned property). | existing db `rls.test.ts` (`property`) + the migration adds no `CREATE POLICY` (diff-visible) |
| ISO-02 | The public read shall expose the policy only through the slug-scoped `PublicScope` resolver that already serves §4.7, so it is reachable exactly where the property itself is - and an archived property's policy 404s with it (ADR-0006). | api `public-properties.spec.ts` (archived property → 404, policy never rendered) |

## 7. Out of scope (deferred by name)

Structured refund rules or any automated refund (CP-03 - it needs the money-path access ADR-0039
removed on purpose) · **recording terms acceptance per user** (an `accepted_terms_version` column +
consent timestamp; needed the first time the terms change materially, and cheap to add then - today
there is one version and no amendment to prove consent against) · a ZH translation of the legal text
(PL-03) · a cookie-consent banner (PL-09 - there is nothing to consent to while the only cookie is
strictly necessary; a banner would be cargo cult, and PL-09's tripwire firing is the trigger to
revisit) · a per-property privacy policy or DPA · a status page (P0-4 owns operational disclosure) ·
Sambung's own subscription billing and its terms (there is no billing to write terms about yet - PL-08
says so plainly instead of inventing them) · house rules, check-in instructions and any other
guest-facing property prose (a content model, not a legal one).

## 8. One open question for the owner - not blocking this slice

P0-1 is written as "Midtrans **production activation**", but ADR-0039 moved every guest payment onto
the **owner's** merchant credentials - so it is worth naming whose activation P0-1 actually is: the
pilot property's (yours, as customer #1), or a Sambung platform account, which is only needed once
Sambung charges owners a subscription. The answer changes no row above - these pages are needed either
way - but it changes what "P0-1 done" means, and PL-08's wording is written for the answer *there is no
platform billing yet*.
