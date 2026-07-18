# ADR-0007: One brand, two surfaces - rethemed shadcn for owners, custom-on-headless for guests

- **Date**: 2026-07-18
- **Status**: Accepted
- **Issue**: #91
- **Companion**: [docs/design-system.md](../design-system.md) (the decided values; this ADR records why the architecture is shaped this way)

## Context

Until now the web app had no design system: four placeholder `--color-brand-*`
tokens (stock Tailwind blue, annotated "refine in M5 polish") and zero shared
primitives - every input and button is a copy-pasted utility string, and
`text-gray-500` vs `text-gray-600` already disagree about what "muted" means on
different pages.

M2 changes what that costs. The guest booking funnel is the first UI a stranger
uses to decide whether to hand over money, and it needs the hardest behavioral
widgets in the app: a date-range picker with keyboard navigation and
screen-reader semantics, confirm dialogs, toasts - all already promised by
page-spec. "Make it pretty in M5" would mean building the portfolio's money
pages twice, and retrofitting a token system under ~15 pages instead of 7.

Two goals pull against each other. As a portfolio, the public funnel must look
*designed* - a stock component library's default face reads as template, the
thing the owner explicitly rejected ("not AI slop"). As a solo project on a
schedule, hand-writing dialog focus traps and calendar ARIA is weeks of a11y
work that guests only notice when it is wrong - the classic way portfolio
projects ship inaccessible UI.

## Decision

**One token source, two component strategies.**

1. **Semantic tokens are the only vocabulary pages may speak** (`bg-background`,
   `text-muted-foreground`, `bg-primary`, ...). The raw ramps (stone neutrals,
   terracotta accent - values in the design-system doc) live in exactly one
   file, `packages/config/tailwind.css`, which defines what each semantic name
   means. All existing pages migrate in one sweep PR (#91), before M2 UI lands
   on top.
2. **Dashboard (`/app/*`) = shadcn/ui, rethemed.** The CLI copies component
   *source* into `apps/web/src/components/ui/` - owned code on Radix
   primitives - themed entirely from the token file. Copied in per need, never
   the catalog.
3. **Public funnel (`/p/*`, `/booking/*`) = custom components on headless
   behavior.** Every visible pixel is designed from the brand book; widgets
   with real interaction complexity stand on headless machinery
   (`react-day-picker` for the calendar, Radix primitives for dialog/popover)
   that contributes keyboard, focus, and ARIA behavior only. shadcn components
   are not imported by `features/public-booking/` - the acceptance criterion
   that keeps the doctrine real.

## Why

**The split follows where taste pays.** A guest decides whether to trust an
unknown villa's checkout in seconds; an owner uses the properties table daily
and wants it boring and dependable. Spending hand-design where guests look and
industry-standard components where owners work puts the effort exactly where
each audience rewards it. One token source keeps the two surfaces one product.

**Copy-in over library dependency.** shadcn's model - source in the repo - means
the a11y implementations are readable and modifiable (the learning goal), there
is no library to outgrow or retheme against, and the "another shadcn app" look
is avoidable by construction: the stock palette never enters the token file.
A full library (Mantine/MUI) was rejected as hardest to brand and least
instructive; fully hand-rolled was rejected as an accessibility liability.

**Semantic-only pages are the derive-don't-store grain applied to CSS.** The
codebase already refuses to store what can be derived (availability,
`publishable`, effective-archived). A page that hardcodes `text-stone-500`
stores a decision that `muted-foreground` derives; the sweep makes the token
file the single place color decisions live, so retheming is a swap, not a
hunt. Sweeping now, at 7 pages, is the cheapest it will ever be - incremental
migration guarantees a two-dialect codebase through M2-M4.

**Custom-on-headless splits look from behavior at the right seam.** "Own
components" on the funnel must mean owning the *look*; the keyboard handling of
a date-range picker is undifferentiated, hard, and already solved. The headless
libraries carry zero visual opinion, so distinctiveness costs nothing - and the
alternative (hand-written calendar ARIA) spends boss-fight-sized effort on a
problem with no domain payoff.

## Consequences

- **M2's availability picker starts from `react-day-picker` + brand tokens**,
  not from scratch and not from a stock calendar component.
- **A grep enforces the doctrine's edge**: shadcn imports appearing in
  `features/public-booking/` are a review flag, as is any raw ramp utility in
  feature files.
- **New dependencies enter** (radix primitives, cva, tailwind-merge, clsx,
  lucide-react, sonner, @fontsource packages - all MIT/free, invariant #8
  intact). Accepted as the price of owned a11y; each shadcn component adds only
  its own radix packages.
- **The dashboard will still faintly resemble shadcn structurally** (it shares
  Radix DOM patterns). Accepted: owners are not judging novelty, and the
  retheme removes the recognizable skin.
- **Brand values themselves stay cheap to change** - that is the point of the
  semantic layer. What is expensive to reverse is the component strategy, which
  is why this ADR exists and the palette merely lives in the companion doc.
