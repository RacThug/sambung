# Sambung - Design System (v1)

> **What this is:** the brand and UI system - the decisions every screen is built from, decided 2026-07-18 (grill session, owner-approved per decision). Architectural rationale lives in [ADR-0007](adr/0007-two-surface-design-system.md); implementation is tracked in #91.
> **What this is not:** a page inventory ([`page-spec.md`](page-spec.md)) or a component catalog (that grows in `apps/web/src/components/`).

---

## 1. Brand

- **Name:** Sambung (Indonesian: *to connect*). Decided against a rebrand; PRD §10.4 is closed.
- **Personality:** **the gracious host** - warm, grounded, quietly confident. The UI recedes behind property photography; trust comes from calm, not from chrome. Chosen over "reliable operator" (cool SaaS - the templated look, and cool chrome fights warm villa photos) and "boutique brand" (high-effort, and over-styled checkouts cost trust).
- **Voice:** plain, hospitable, specific. A control says exactly what happens ("Book - Rp 2.550.000 total"). Errors say what went wrong and what to do next. No exclamation marks doing the work of clarity.
- **Wordmark:** lowercase **`sambung`**, Fraunces semibold, terracotta-600. Used in the dashboard header, auth pages, and the public-page "powered by" footer. Square contexts (favicon, app icons): lowercase "s" on a terracotta rounded tile (SVG). There is no drawn symbol, deliberately - a wordmark done well beats an amateur mark.

## 2. Color

Two rules before any value:

1. **Pages speak semantic tokens only** (`bg-background`, `text-muted-foreground`, `bg-primary`, ...). The raw ramps below exist in exactly one file - `packages/config/tailwind.css` - which defines what each semantic name points at. Retheming is a token swap, never a find-and-replace.
2. **The accent is not a status.** Terracotta means "Sambung is talking / act here". Status speaks through the semantic trio only.

**Neutrals - stone** (Tailwind v4 `stone`, warm gray): the surface everything sits on. Chosen over cool `gray` - the warm undertone is most of "gracious host" at the token level.

**Accent - terracotta** (custom ramp, tuned brown-ward so it never reads as error-red):

| step | value | role |
|---|---|---|
| 50 | `#fbf3ee` | tinted fills (badges, hovers) |
| 100 | `#f6e3d8` | tinted fills |
| 200 | `#edc5b0` | decorative |
| 300 | `#e1a184` | decorative, on-dark accents |
| 400 | `#d47c57` | large decorative only |
| 500 | `#c05f35` | hover companions |
| **600** | **`#a84c26`** | **the workhorse: CTAs, wordmark, links, focus ring** (white text: 5.6:1, AA) |
| 700 | `#8a3d1e` | hover/active on 600 |
| 800 | `#6d301a` | text on terracotta tints |
| 900 | `#572715` | deep text accents |

Chosen over deep ocean teal (elegant, zero collisions, but "warmth at arm's length") and palm green (permanent tension with success states). Checked against: danger `#dc2626`, success `#16a34a`, warning `#d97706`, and the M5 calendar's OTA source colors (Airbnb coral `#ff5a5f`, Booking navy `#003580`).

**Semantic trio:** danger `#dc2626` · success `#16a34a` · warning `#d97706`. Exact ramps finalized in #91 with contrast checks.

**Theme:** light only in v1 (page-spec lists theme switching as a non-goal). Token architecture keeps a dark theme *possible*, not promised.

## 3. Typography

**Plus Jakarta Sans** - all UI and body text, both surfaces. Weights 400 / 600 / 700. A humanist sans commissioned for Jakarta's city identity: an Indonesian product setting its interface in an Indonesian typeface is brand alignment, not trivia. Covers EN and ID (both Latin).

**Fraunces** - display serif, weights 400 / 600. Appears **only** where a guest forms a first impression: public-page headings, property names, and the wordmark. It never appears in dashboard UI chrome - warmth where guests look, clarity where owners work.

**Chinese (ZH)** renders through the system CJK stack appended to every font token (`"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"`). Self-hosting a CJK face is multiple MB for no v1 gain; this is the shipped design, not a fallback of shame.

**Delivery:** `@fontsource` packages, bundled by Vite, self-hosted. No font CDN at runtime (invariant #8, privacy, performance). Latin subsets total ~72 KB woff2.

**Numbers:** money and any column of digits get `tabular-nums`. `Rp 14.000.000` per page-spec §2.

## 4. The two surfaces (the core doctrine)

One brand, one token source - two component strategies:

- **Dashboard (`/app/*`): shadcn/ui, rethemed.** Components copied into `apps/web/src/components/ui/` (owned code, Radix a11y underneath), themed entirely from the token file. Copy in per need, never the whole catalog. Owners get dependable, boring-in-the-good-way software; we do not hand-design admin tables.
- **Public funnel (`/p/*`, `/booking/*`): custom components.** Designed from this document directly - gallery, unit cards, price summary, CTAs carry the brand's actual point of view. **No shadcn imports in `features/public-booking/`.** Where a widget has real interaction complexity (calendar, dialog, popover), it stands on a **headless** library - `react-day-picker`, Radix primitives - contributing keyboard, focus, and ARIA behavior only; every visible pixel is ours.

The line: *own the look everywhere guests look; never hand-write accessibility that headless libraries have already gotten right.*

## 5. Supporting cast

| need | choice | note |
|---|---|---|
| icons | `lucide-react` | tree-shakeable, MIT; both surfaces |
| date picking | `react-day-picker` | headless; arrives with the M2 availability picker |
| class variants | `cva` + `tailwind-merge` + `clsx` | arrive with shadcn |

All free (invariant #8). Anything heavier gets flagged before it enters.

**Removed 2026-08-01: `sonner`.** It was listed here for "page-spec §2's 5xx/network toasts" and mounted
in `main.tsx`, and **nothing ever called `toast()`**. Feedback in this app is inline, beside the control
that caused it, which `sync-now-button.tsx` argues for in place: a sync summary is something an owner may
want to read twice, and a toast takes it away on a timer. The global surface that WAS missing is a
render-time error boundary and a 404 route, and those now exist on the router
([`pages/_list-pattern.md`](pages/_list-pattern.md) D6/D7).

## 6. Working agreements

- New UI starts from semantic tokens; a raw `stone-*`/`terra-*` utility in a feature file is a review flag.
- Public-funnel PRs include a screenshot - the taste bar ("be picky about the UI") is enforced by eyes, not lint.
- The visual companion (mocks, specimen, wordmark candidates) lives in the owner's artifact "Sambung - Brand Decisions"; this file is the source of truth when they drift.
