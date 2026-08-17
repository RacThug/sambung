# Sambung: Gap Analysis — From Current Repo to First Paying Guesthouse

**Date:** 17 Aug 2026 · **Basis:** repo state at `RacThug/sambung` (last commit 2 Aug 2026) + competitive research (Aug 2026)

## Where the repo already stands

Verified in code, not just docs:

- Direct booking funnel (`/p/:slug` → checkout → confirmation) in EN/ID/ZH
- Midtrans Snap integration (sandbox) with deposit support, payment inbox, idempotent webhook handling
- Two-way iCal sync: import sweeper (30-min pull), `.ics` export, sync-conflict detection
- Availability as source of truth, enforced at the DB layer (`daterange` + GiST exclusion constraint)
- Multi-tenancy with Postgres row-level security; auth with refresh cookies; staff invitations
- Owner dashboard: calendar, reservations, channels, bookings, CSV export
- Email notifications via Resend (confirmation emails), photo storage via presigned R2/Garage
- Single-VPS deploy *config* (Caddy, auto-TLS) - committed and behaviourally verified locally (edge profile + `og:doctor`, ADR-0035), but **no live deployment exists yet**; e2e suite, ADRs, page specs

This is materially the "Phase 1 / iCal-first" product from the competitive research. The gaps below are what stand between this and a real guesthouse paying money.

---

## P0 — Blockers. No first customer without these.

### 1. Midtrans production activation (business, not code)
Sandbox → production requires a registered merchant: legal entity or at minimum a registered sole proprietorship with NIB (OSS), bank account in the business name, and Midtrans's merchant review. Lead time is weeks, not days — **start this before writing more code.** QRIS, GoPay, VA, and cards all come through this one activation, which covers the "local payments" differentiator identified in the research.

*Decision needed:* PT Perorangan (cheap, fast, solo-friendly) vs. staying informal and delaying payments. Recommendation: PT Perorangan — it also unblocks future OTA/aggregator contracts.

### 2. Date-based pricing
Units currently carry a single flat `basePriceIdr`. No Bali property runs a flat rate: Aug/Dec–Jan peaks, Nyepi, Galungan, weekend uplifts. Without per-date pricing, a real owner either loses money or refuses to onboard.

Minimum viable: a `unit_price_overrides` table (date range → nightly price) layered over the base price, editable from the calendar. Explicitly defer: rate plans, occupancy-based pricing, LOS rules — that's Channex-phase work.

### 3. Live-OTA iCal validation
The iCal path is tested against a fake fetcher. Before onboarding anyone, run one real property (yours or a friendly owner's) with live Airbnb + Booking.com feeds for 2+ weeks. Expect quirks the fake won't show: feed URL rotation, DTSTART/DTEND timezone edge cases, OTA-side refresh lag, silent 404s. The sync-conflict module will earn its keep here.

Set expectations in-product: show "last synced from Airbnb: X min ago" per channel, and state plainly that iCal cannot prevent all double-bookings — honesty here is a trust feature, and review research shows overbooking anxiety is the #1 emotional issue in this market.

### 4. Production-grade operations
A portfolio VPS and a "someone else's revenue depends on this" VPS are different machines:
- Automated offsite Postgres backups (e.g. nightly `pg_dump` → R2) **with a tested restore**
- Error tracking (Sentry or similar) and uptime monitoring with alerting to your phone
- A minimal status page or at least a stated support channel

### 5. Legal & trust pages
Terms of service, privacy policy, refund/cancellation policy (guest-facing, per property), and a real support contact. Required by Midtrans production review anyway.

---

## P1 — First month of operation. Needed roughly when customer #1 goes live.

### 6. Manual booking origin (the thin PMS slice)
**Mostly shipped** (#50, ADR-0011): walk-ins and manual blocks are entered from the dashboard calendar today - guest name + phone, born `confirmed`, cancellable, flowing through the same availability chokepoint as guest bookings, e2e-covered. The remaining delta is small: record the entry channel explicitly (walk-in / WhatsApp / phone - today a walk-in is `source=direct` with entry-method deliberately derived, ADR-0011), and an optional payment status on manual bookings.

### 7. WhatsApp notifications
The research wedge — and currently absent (email only). Start narrow: booking confirmation + payment received to the **owner** via WhatsApp, then guest check-in reminders. Options: Meta WhatsApp Cloud API (official, template approval overhead) vs. local gateways (Fonnte, Wablas — faster, cheaper, less official). Recommendation: local gateway for owner notifications now; migrate guest-facing messages to Cloud API later. Mirrors the pattern already built for Mahesa Dupa.

### 8. Check-in / check-out status
A booking state (upcoming → checked-in → checked-out) on the reservation views. Small change, large perceived "this is a PMS" value.

### 9. Onboarding funnel polish
Register flow exists; measure it against the research benchmark: *a non-technical Bahasa-speaking owner live in under 30 minutes without a call.* Add an in-product checklist (add property → add unit → set prices → paste OTA iCal URLs → share booking link), with ID as the presented default language.

---

## P2 — Growth. After 3–5 paying properties.

10. **Channex adapter** — second implementation beside the iCal fetcher behind the existing channel-sync abstraction; brings real-time ARI + rates to Booking.com/Agoda/etc. Trigger (from research): ≥5 paying properties, or first churn/complaint caused by iCal lag. Unit-level pricing applies ($0.50/unit + $130/mo platform).
11. **Owner statements** — automated monthly PDF/email per property; the wedge for third-party-managed villas.
12. **Multi-unit tape chart** — only when a customer with 8+ units actually asks.
13. **Long-stay module** (≥28-night inventory, deposits, contracts) — only on demonstrated demand (>15% of base).

---

## Positioning decision (do this week, costs nothing)

The public README says "portfolio and learning project, built solo." Prospective customers who look will read that as "not a real product." Either:
- **(a)** Rewrite the README as a product (move the engineering-showcase narrative to `docs/engineering.md` — it's genuinely good portfolio material and can stay), or
- **(b)** Take the repo private and extract a separate public portfolio write-up.

Recommendation: (a) — the write-up is an asset for both audiences if separated.

## Suggested sequence (solo, ~6–8 weeks to first onboarding)

| Week | Focus |
|---|---|
| 1 | Start PT Perorangan + NIB + Midtrans production application (long pole). Rewrite README. Start live-OTA iCal pilot on one real property. |
| 2–3 | Date-based pricing (P0-2). Backups + monitoring (P0-4). |
| 4 | Legal pages (P0-5). Manual booking entry (P1-6). |
| 5 | WhatsApp owner notifications (P1-7). Check-in/out status (P1-8). |
| 6 | Onboarding checklist + ID-first polish (P1-9). Review pilot's sync logs; fix quirks. |
| 7–8 | Onboard guesthouse #1 with white-glove attention; their friction list becomes the next backlog. |

**Pricing at launch (from research):** flat IDR 300–600k/month, no setup fee, no per-booking commission, long free trial. Revisit only after ~10 paying properties.
