# ADR-0024: The funnel speaks three languages, the wire speaks one

- **Status**: Accepted
- **Date**: 2026-07-20
- **Issue**: #58 (M5, FR-I18N-1)
- **Supersedes/relates**: ADR-0007 (design system, CJK fallback), ADR-0012 (a 409 carries a code, not a sentence), ADR-0023 (funnel/dashboard are two bundles)

## Context

The public funnel (property page -> checkout -> confirmation, plus login) must speak
EN / ID / 中文: a language switcher persisted per visitor, localized copy end to end,
locale-aware date display, and localized availability blocked-reasons. There is no
i18n infrastructure in the repo - this is greenfield. Invariant #8 says flag a heavy
dependency. api-spec §1 says public endpoints accept `Accept-Language` / `?lang` for
localized copy, but the **data** is language-neutral; §5.1 and the shared availability
schema spell it out for the reasons specifically: "Slugs only, no prose ... the SPA
composes localized copy from the slug".

## Decision

**1. No i18n library. A dependency-free, type-safe message catalog + a tiny React
context.** Three flat string catalogs (`i18n/messages/{en,id,zh}.ts`) whose values are
plain strings with `{token}` placeholders. `type Messages = typeof en`; `id` and `zh`
are annotated `: Messages`, so a missing, extra, or mistyped key is a **compile error**.
A `useI18n()` hook exposes `t(key, params)` (typed key, `{token}` interpolation) plus
locale-bound `fmtDate` / `fmtNights` / `fmtGuests`. This matches the house style - the
codebase already composes copy from typed exhaustive switches with zero libraries
(`lib/conflict.ts`, `availability-copy.ts`) - and adds **zero runtime dependencies**.
react-i18next / react-intl (tens of KB, ICU machinery) buy pluralization and
lazy-namespaces we do not need for three languages where only EN inflects nouns; the
platform `Intl` API and react-day-picker's already-bundled `id`/`zh-CN` locales cover
dates and the calendar for free.

**2. The wire format never changes; only display follows locale.** Every date crosses
the wire as `YYYY-MM-DD` (the search-param and API schemas are untouched). Display goes
through `Intl.DateTimeFormat(tag)` with `tag` = `en-GB | id-ID | zh-CN`; the calendar
picker takes react-day-picker's bundled locale object. Money stays `id-ID` everywhere
(currency locale, not visitor - unchanged, see `lib/money.ts`).

**3. Choice persists in `localStorage` (`sambung.lang`), never touching tokens.** Read
at load (fallback: `navigator.language` -> id/zh/en, else en). The store is a
framework-agnostic external store (`useSyncExternalStore`); the api-client reads it to
send `Accept-Language` on every request. Access/refresh tokens are unaffected - they
stay in memory / httpOnly cookie (invariant, page-spec §2 explicitly permits
localStorage for the language *preference*).

**4. Availability blocked-reasons stay language-neutral slugs on the wire; the SPA
localizes them.** This is the approach api-spec §1/§5.1 and the shared schema *mandate*
("the SPA composes localized copy from the slug"), and the ADR-0012 precedent ("the web
owns all copy; server prose is never rendered"). No server change: the reason enum is
already the machine-readable contract, and the funnel's copy module turns each slug +
`minStay`/`blockedRanges` into localized prose. The AC "arrive localized from the API"
is satisfied at the product level - the reasons the guest reads are localized - by the
architecture the spec requires. `?lang` / `Accept-Language` remain an accepted,
currently no-op convention (a future seam if a non-SPA client ever needs server prose).

**5. Provider at the route-tree root; switcher rendered at the root, gated to public
routes.** The `I18nProvider` wraps the root route (so `useI18n` is available app-wide and
every test that renders the real tree gets it). A `PublicShell` bar is rendered once at
the root, above the matched page, but returns `null` when the pathname starts with `/app`
- so the switcher shows on the funnel + login / register only, and the dashboard stays
English (page-spec §2, "public pages + login"). Gating by pathname (rather than a pathless
layout route) keeps the route tree and every absolute path exactly as they were.

## Alternatives considered

- **react-i18next / react-intl / lingui.** Rejected per invariant #8: a heavy dep for a
  problem the platform + a 60-line catalog solve. Their headline feature (ICU plurals)
  matters for one language here; EN pluralization is two `n === 1` checks.
- **Localize reasons server-side (per the literal AC wording).** Rejected: it
  contradicts api-spec §5.1 ("slugs only, no prose") and the shared schema comment,
  duplicates the copy catalog into a second codebase, defeats response caching (a
  cacheable quote would vary by header), and breaks the ADR-0012 "code not sentence"
  spine that keeps machine-identity and human-copy as separate concerns.
- **A lint rule scanning for missing keys.** Rejected as the *primary* guard: the
  type annotation already makes a missing key a compile error (stronger, and it runs in
  the pre-push `typecheck` and the web `build`). A vitest parity + token test is kept as
  the explicit, runnable "lint or test" AC and also catches empty strings and a
  translator dropping a `{token}`.

## Consequences

- New copy **cannot ship EN-only**: add a key to `en` and forget `id`/`zh` -> `tsc`
  fails (`pnpm typecheck`, pre-push, and web `build`); the parity/token test fails too
  (`pnpm test`).
- The funnel entry chunk grows by three small string catalogs + the picker's three
  bundled calendar locales; kept under the ADR-0023 budget (185 KB gzip), guarded by
  `scripts/check-bundle.mjs`.
- The dashboard is untouched (English); localizing it later is additive - wrap it in a
  switcher shell and route its copy through the same catalog.
- CJK renders through the system stack already appended to every font token (ADR-0007);
  no font work.
