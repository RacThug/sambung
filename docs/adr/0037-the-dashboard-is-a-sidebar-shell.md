# ADR-0037: The dashboard is a sidebar shell, and width follows the page's job

- **Date**: 2026-07-23
- **Status**: Accepted
- **Issue**: UI/UX review (grill session 2026-07-23); a follow-up to the #60 demo-readiness pass
- **Related**: [ADR-0007](0007-two-surface-design-system.md) (the two-surface design system this
  lives inside - dashboard = shadcn-rethemed, semantic tokens only), [ADR-0010](0010-the-calendar-is-composed-not-served.md)
  and [#51](https://github.com/RacThug/sambung/issues/51) (the wide data views this unboxes),
  [ADR-0034](0034-one-identity-many-memberships.md) (the workspace switcher the sidebar now hosts)

## Context

Every `/app/*` page rendered inside one shell: a flat horizontal top-nav (wordmark + five text
links + the workspace switcher + a bare "Log out"), with **nav *and* content both boxed to
`max-w-4xl` - 896px**. That box is the load-bearing problem. The two surfaces an owner operates
all day are wide data views - the multi-property calendar timeline (ADR-0010) and the reservations
table - and 896px strangles both, leaving hatched dead space either side on a normal monitor. On
top of that the shell never showed *who* was signed in (just a logout link), the flat nav did not
group or scale as it grew, and there was no mobile treatment at all: the flex row of links simply
overflowed on a phone.

"A dashboard has a sidebar" is a **pattern, not a law** - GitHub and Stripe ship perfectly good
top-nav dashboards. So the question was not "sidebar because that's correct" but "does *Sambung's*
usage earn one?"

## Decision

**Reverse the top-nav into a sidebar shell, and let content width follow the page's job.**

1. **A left sidebar** (`sidebar.tsx`): the workspace context at the top (the ADR-0034 switcher,
   which stays a plain label for the common one-seat account), then navigation grouped into
   **Operate** (Calendar, Reservations, Inbox) and **Manage** (Properties, Settings), with lucide
   icons. The split is real, not decorative: Operate is the live queue you work; Manage is how the
   business is configured. The Inbox item carries a **count badge** (open sync conflicts + lapsed
   payments, `use-inbox-count.ts` - the same two queries `/app/inbox` reads, so badge and page
   cannot disagree), fulfilling page-spec §4.6's "open-conflict count badged in the nav".
2. **A slim top bar**: an **account menu** (the signed-in email + role + Log out) - the identity the
   old shell never showed - and, on mobile, the nav trigger.
3. **Content width by route-type.** The two data views (`/app/calendar`, `/app/reservations`) go
   **full-bleed**; every other page (forms, detail, lists) **caps at ~1024px** for a readable
   measure. One rule, decided once in the shell from a `WIDE_ROUTES` set - *derive-don't-store*
   applied to layout, so no page hand-sets its own width and a form can't stretch to 200-character
   lines on a wide monitor.
4. **Mobile = the same sidebar as a drawer**, collapsed behind a hamburger. It stands on
   **Radix Dialog** (already a dependency via `dialog.tsx`) for the focus-trap / Escape / scroll-lock
   an accessible modal needs - per ADR-0007, we do not hand-write a11y a headless primitive already
   gets right. The small corner account menu, which needs no focus trap, is hand-rolled with the
   a11y that *does* matter there (`aria-haspopup`/`aria-expanded`, Escape, outside-click).
5. **Inside ADR-0007, no new anything.** Semantic tokens only (the active nav state is the terracotta
   `accent` tint), no new dependency (reuses the installed Radix Dialog + lucide), no new colour or
   font. The change is structural, not a re-theme.

## Deliberately deferred

The agreed design also put the **page title and that page's primary action in the top bar**. Only
the account menu ships there now, for one honest reason: a route-derived title is clean for the five
static pages but *wrong* for the detail routes (`/app/bookings/:id`, `/app/properties/:id`), whose
heading is a dynamic name, not the route; and lifting each page's primary action (New property,
Export CSV) into the top bar needs a per-page title/action **registration** mechanism. That is a
separate refactor. This ADR ships the structural spine - sidebar, width, identity, mobile - and the
title/action-in-top-bar is a follow-up. Pages keep their own `<h1>` and in-content actions unchanged,
so this PR touches no page.

## Consequences

- The calendar and reservations finally use the screen; every other page reads at a comfortable
  width. The 896px box is gone.
- The nav has a home for growth (two groups) and a live signal (the inbox badge), and the shell
  works on a phone.
- The badge adds two small queries (`/sync-conflicts`, `/payments/lapsed`) on every `/app` page.
  They share the inbox page's cache keys, so there is no double fetch, and a load error reads as 0 -
  a nav badge is best-effort, never a blocker.
- The bundle is unaffected where it matters: the shell is dashboard-only, so the funnel-entry budget
  (ADR-0023, `check-bundle`) is unchanged - the guest on `/p/:slug` never downloads it.
- **Independent review before merge** is warranted: the shell touches the auth session (the account
  menu's logout) and the workspace switcher.

## Alternatives considered

- **Keep the top-nav, just repair it** (widen content, add icons, a mobile menu). Rejected: it does
  not solve the width problem as cleanly - a centered content column persists - and a flat bar does
  not group the live queue apart from configuration or give the nav room to grow. For a tool an owner
  lives in, a persistent, scannable rail is the better fit.
- **A collapsible icon-only rail** (maximum content width, hover to expand). Rejected for v1: icon-only
  nav is a discoverability cost for an owner who opens the dashboard occasionally, not all day. A
  labelled rail is clearer; the icons are in place, so this stays an easy future option.
- **Put the account menu / workspace at the sidebar bottom** (Linear/Notion style), no top bar.
  Rejected: the grill session put the account menu in the top bar, and a top bar is where the mobile
  nav trigger has to live anyway.
