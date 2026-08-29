# EARS spec - Legal & trust pages (PRD-product P0-5, REQ-TR-01)

**Status:** draft (owner decisions taken 2026-08-29 - hybrid scope, *perorangan now / PT later*,
ID + EN) · **Traces to:** [`../prd-product.md`](../prd-product.md) P0-5, ADR-0041 (proposed - *a
cancellation policy is the host's promise, not the platform's*), api-spec §4.3 + §4.7 amendments,
page specs [`../pages/p-slug.md`](../pages/p-slug.md) / [`../pages/p-slug-book.md`](../pages/p-slug-book.md)
/ [`../pages/app-properties-propertyId.md`](../pages/app-properties-propertyId.md) /
[`../pages/register.md`](../pages/register.md), [`../sitemap.md`](../sitemap.md) §2, shared contract
`packages/shared/src/property.ts` + `public-property.ts`, evidence
[`../research/legal-requirements-id.md`](../research/legal-requirements-id.md), **migration 0019**.

> **Format** as [`honesty-sync-ux.md`](./honesty-sync-ux.md): one testable sentence per row; the
> **Verified by** test is what makes it falsifiable - a row whose named test does not prove it is a
> claim, not a requirement.

**The gap this closes.** There is no `/terms`, no `/privacy`, and no word anywhere in the funnel about
what happens to a guest's money if they cancel. A guest today pays a deposit (ADR-0015) on the strength
of a page that never states a single condition.

**The justification the PRD gave for this slice does not survive its own research, and the slice does.**
`prd-product.md` P0-5 says these pages are "required by Midtrans production review anyway"; Midtrans's
own documentation asks only that the business link be publicly reachable with goods and prices visible,
and names no legal page at all (research §1). What *does* require them is closer to home and harder to
argue with: **UU PDP Pasal 21** obliges a disclosure Sambung makes nowhere, **PP 80/2019** wants an
electronic contract the consumer can keep, and a guest is being asked to pay against no stated terms.
The research also removes a second inherited assumption - that P0-5 unblocks P0-1. It does not; the two
are independent, and P0-5 is first because it is the one that can be finished here (research §5).

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
| PL-03 | The Indonesian text shall be AUTHORITATIVE and the English a courtesy translation, stated in that wording on each page. An unauthored locale (ZH) shall fall back to **English**, not Indonesian - a reader who chose ZH is likelier to read EN than ID. PP 80/2019 independently requires an electronic contract aimed at consumers in Indonesia to be in Bahasa Indonesia (research §4), so ID-authoritative is not merely the owner's preference. | web `legal-page.test.tsx` (locale `id` → ID body; `en` and `zh` → EN body + the "Indonesian version prevails" line) |
| PL-04 | The legal identity - entity name, address, contact email, effective date, version - shall live in ONE module read by all three pages, so the switch from *perorangan* to PT Perorangan is one edit, not a sweep of three prose files. | web `legal-page.test.tsx` (all three pages assert the SAME entity string, sourced from the constant) |
| PL-05 | Each page shall display its effective date and version, so a later amendment is legible rather than silent. | web `legal-page.test.tsx` |
| PL-06 | The legal prose shall NOT enter the i18n message catalogue: catalogues are UI strings, keyed and parity-checked across three locales, and long two-locale prose there would either break that parity or force a fabricated ZH legal translation. Content modules per locale instead, lazily loaded. | existing web `i18n/messages/catalog.test.ts` stays green with no ZH legal keys added; `check-bundle.mjs` shows legal content in its own chunk, not the funnel's |
| PL-07 | The pages shall be reachable with NO authentication and NO session, from a cold deep link. | e2e `funnel/legal-pages.spec.ts` (opened in a fresh context with no storage state) |
| PL-08 | `/legal/refund` shall state plainly that (a) Sambung charges the owner nothing today, so there is no subscription refund to make, and (b) **guest booking refunds are the host's**, governed by the property's own policy - with a pointer to where that appears. A refund page silent on the second half would be the exact conflation this slice exists to prevent. | web `legal-page.test.tsx` (both halves asserted) |
| PL-08a | `/legal/refund` shall also state the mechanical truth behind (b): a booking paid by **bank transfer / Virtual Account - the dominant Indonesian method - cannot be refunded through the payment provider at all** and comes back as a manual transfer from the host (research §2). Naming this is what stops "the host decides" from reading as evasion; it is a property of the rails, not a policy choice. | web `legal-page.test.tsx` |
| PL-09 | `/legal/privacy` shall name what is actually true of this system rather than boilerplate: the only cookie is the first-party refresh session cookie (strictly necessary - no consent banner is required, and none is shown), locale is a `localStorage` preference, there is **no third-party analytics or tracking script**, and the named processors are Midtrans (payments), Resend (email) and the object store (photos). | web `legal-page.test.tsx` (names the three processors and the no-tracking claim) + `no-trackers.test.ts` - a tripwire walking `apps/web/src` + `index.html` for analytics snippets, so the *claim* fails the build if it ever stops being true |
| PL-10 | `/legal/privacy` shall state the UU PDP (UU 27/2022) roles honestly: Sambung is **controller** for owner account data (Pasal 1 angka 4 - it determines the purpose) and **processor** for guest booking data handled on the owner's behalf (Pasal 1 angka 5 - *atas nama pengendali*). | web `legal-page.test.tsx` |
| PL-11 | `/legal/privacy` shall be structured to answer **Pasal 21's seven items** - legality, purpose, type and relevance of the data, retention period, what is collected, processing period, and the data subject's rights - rather than a generic template's order, so a reader can check them off (research §3). | web `legal-privacy-content.test.ts` - the ID and EN content modules each expose seven named sections and the test asserts all seven are present and non-empty in BOTH, so a half-translated page fails rather than silently dropping an item |
| PL-12 | The retention answer required by PL-11 (items d and f) shall be a **stated policy**, not a description of whatever the database happens to keep. It is an owner decision, recorded in the decision log before the prose is written - a legal page is the wrong place to discover a product question. | no test - a process requirement, discharged by the decision-log row existing before the implementation PR. Named here because writing an unconsidered retention period into a published policy is the failure it prevents |

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
| CP-03 | The policy shall be FREE TEXT, not structured rules (no "X% up to N days"). Structured rules imply an automated refund, and there are TWO independent reasons no such automation can exist: ADR-0039 keeps Sambung out of the money path, and the provider itself cannot refund a Virtual Account payment at all - the dominant Indonesian method comes back as a manual bank transfer by the host (research §2). Encoding a schedule nothing can execute is a promise displayed as a capability. | no test - a design constraint whose evidence is the ABSENCE of a rules schema, now backed by research §2. Stated here so a later "just add a percentage field" reopens the argument rather than sliding past it |
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
| GU-04 | The guest confirmation email shall carry the policy verbatim (or, when none is stated, the same honest line), because the moment it becomes binding is the moment the guest needs their own copy. **This row is load-bearing, not a courtesy:** PP 80/2019 wants an electronic contract the consumer can download or store, and the email is the only artefact in this system a guest keeps (research §4). | api `confirmation-email.spec.ts` (a policy appears in the guest text body; the null case carries the honest line; the OWNER copy does not repeat it - the owner wrote it) |
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

## 8. Open questions for the owner

**Blocking the prose, not the structure.** Every row above can be built as specified; these decide what
the pages *say*.

1. **Data retention (PL-12).** Pasal 21 items (d) and (f) require stating how long personal data is kept
   and for how long it is processed. Sambung has never answered this: a cancelled booking's guest name
   and phone sit in the ledger forever, because the ledger was designed to be permanent (ADR-0002). The
   two are not obviously compatible, and the answer is a product decision - keep the booking row and
   redact the guest's contact details after N months is one shape - not a sentence to improvise into a
   published policy.
2. **Whose Midtrans activation is P0-1?** ADR-0039 moved every guest payment onto the **owner's**
   credentials, so "production activation" now means either the pilot property's account (yours, as
   customer #1) or a Sambung platform account, which only matters once Sambung bills owners. PL-08 is
   written for the answer *there is no platform billing yet*.
3. **The entity decision may be cheaper than the PRD assumed** (research §1). Midtrans documents **KTP +
   NPWP** for a *perorangan* account; NIB appears only in the badan-usaha list. If that holds, PT
   Perorangan is a tax, liability and future-contracts decision rather than a prerequisite to getting
   paid - and one email to Midtrans support settles it before weeks are spent on it.
4. **Does a host-authored English policy satisfy PP 80/2019's language rule?** The platform pages are
   ID-authoritative (PL-03), but CP-07 keeps the host's own words verbatim in whatever language they
   were written. A Bali host writing for foreign guests will write English. This spec does not settle
   it; it is a question for the same review that reads the terms.

**Not a question, a caveat.** The prose these rows specify is a legal document. It should be drafted
from the research file's evidence, built on a reputable Indonesian template, and read by someone
qualified before it goes live. Nothing in this spec should be taken as a substitute for that.
