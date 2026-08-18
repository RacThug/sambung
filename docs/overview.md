# Sambung - what this system is and what it does

> **Start here.** This is the orientation doc: plain language, feature by feature, with one link per
> topic for going deeper. It deliberately explains nothing twice - every claim links to the doc that
> owns it - and it is updated in the same PR as any feature that changes it (the Project Facts rule).

Sambung (Indonesian: *to connect*) is a **direct-booking engine plus a lightweight channel manager**
for small accommodation owners in Bali - villas, guesthouses, homestays. Guests book and pay the
owner directly, commission-free, on a page the owner shares over WhatsApp or pins to an OTA profile;
meanwhile the OTA calendars (Airbnb, Booking.com, Vrbo) stay in sync through iCal feeds so the same
night is never sold twice. It is multi-tenant (many owners, one deployment), runs on a single cheap
VPS, and uses no paid third-party services.

## Who is in the system

- **Owner** - runs a Tenant (their business): properties, prices, team, settings.
- **Staff** - a team member the owner invited, who sees and operates only assigned properties.
  One person can hold seats at several tenants (a property manager working for two villa owners).
- **Guest / Visitor** - a stranger with a link. Never logs in; the URL is their whole session.
- **Machines** - a subscribed OTA pulling the `.ics` feed, and the payment provider (Midtrans)
  posting webhooks. Neither has an account either.

Full vocabulary (what a "Unit", "Stay", "Hold", "Price Override" precisely mean): [`../CONTEXT.md`](../CONTEXT.md).

## What it does today

### A guest books a stay (the public funnel, EN / ID / 中文)

1. **The property page** `/p/:slug` - photos, description, units with prices. The link is permanent:
   renames never break it, and shared links unfurl as real preview cards on WhatsApp/Facebook.
2. **The availability picker** - a calendar with booked nights greyed out, quoting any selected stay
   live. A night costs its **price override** (peak season, Nyepi, Dec-Jan) if one covers it, else
   the unit's base price.
3. **Checkout** - guest details (international phone field), then a 15-minute hold on the dates and a
   Midtrans Snap payment (QRIS, GoPay, bank VA, cards - sandbox today). A property can take a
   deposit percentage or full payment. If the guest walks away, the hold expires and the dates free
   themselves.
4. **Confirmation** - a page that self-heals (if the payment webhook got lost, opening the page
   reconciles with Midtrans directly), a WhatsApp deeplink to the property, and a confirmation email.

Under all of it: a double-booking is **impossible at the database level** - not "checked", impossible
(a GiST exclusion constraint arbitrates even two simultaneous transactions). See the root
[`README`](../README.md) "five hard parts" for why this is the heart of the system.

### An owner runs the business (the dashboard `/app`)

- **Inventory** - properties and units (a unit = one sellable room/villa), photo galleries with
  drag-order and presigned uploads, a Verified badge from the licence number, per-property deposit %
  and timezone.
- **Pricing** - a base nightly rate per unit, plus dated **price overrides** ("first night / last
  night / price") layered over it. Every surface reprices at once; sold bookings never change price.
- **The calendar** - all units as rows, bookings as bars coloured by source, holds hatched. Click an
  empty day to enter a **walk-in or a maintenance block** by hand; click a bar for the booking
  detail; cancel frees the dates.
- **Reservations** - a filterable table of every booking (window, property, status, source) with
  **CSV export** that respects the active filters.
- **The operations inbox** `/app/inbox` - the two places the system did the safe thing and now needs
  a human: sync conflicts (an OTA sold nights already booked here) and paid-but-lapsed payments
  (money arrived after the hold died).
- **Team** - invite staff by email, scoped to chosen properties. Scoping is enforced in the database
  (row-level security), not sprinkled through the code: an unassigned property simply does not exist
  for that staff member, on every screen and every API call.
- **Settings** - the tenant's gallery cap; **Payments**, where the owner pastes their own Midtrans
  server key (encrypted at rest, never readable back, owner-only); a workspace switcher when one
  account holds several seats.

### Calendars stay in sync (the channel manager)

- **Export**: each unit has a permanent `.ics` URL the owner pastes into the OTA's "import calendar"
  box. The feed carries dates only - never guest names, contacts, or prices.
- **Import**: a 30-minute cron (plus a "Sync now" button) pulls each connected OTA feed and mirrors
  its bookings in. It is deliberately paranoid: a truncated or unreachable feed changes **nothing**
  (never mass-cancel real stays), and an OTA booking that clashes with an existing one is refused by
  the same double-booking constraint and filed in the inbox for the owner to resolve - the machine
  never picks which guest loses.

### Money

Guests pay through Midtrans; the webhook that confirms payment is idempotent (a duplicate or a
replay can never double-confirm), and the confirmation page can reconcile on its own if the webhook
never arrives. Money is integer rupiah end to end - never floats. Payment credentials are
**tenant-owned** ([ADR-0039](adr/0039-payment-credentials-are-tenant-scoped.md)): each owner stores
their own Midtrans key, guest money settles straight into their own account, and Sambung is never in
the money path. A tenant with no key yet is a supported state, not a broken one - everything else
works and the funnel says online payment is unavailable instead of failing at checkout.

## Where it stands

All six original milestones (M0-M5) are complete and everything above runs locally on the
`docker compose` stack - no deploy, no paid account needed (see `demo.md` for the five-minute
walkthrough). The **product phase** is underway: the roadmap to a first paying guesthouse is
[`prd-product.md`](./prd-product.md) (P0-2 date-based pricing and P0-6 per-tenant payment
credentials shipped; Midtrans production activation, a live-OTA pilot, backups/monitoring, and legal
pages remain in P0 - all business or ops work rather than code).

## Lost in the docs? Match your question to the right one

| Your question | Read |
|---|---|
| "What is this / what can it do?" | This file, then [`demo.md`](./demo.md) (the scripted walkthrough) |
| "What was the product contract? What's next?" | [`prd.md`](./prd.md) (original) · [`prd-product.md`](./prd-product.md) (the road to a paying customer) |
| "What exactly does page X do?" | [`pages/`](./pages/README.md) - one spec per page |
| "Which routes and endpoints exist?" | [`sitemap.md`](./sitemap.md) (the code-verified map) → [`api-spec.md`](./api-spec.md) for shapes |
| "How is it built, and why that way?" | [`architecture.md`](./architecture.md) · [`db-design.md`](./db-design.md) (teaching editions) |
| "What does this word mean here?" | [`../CONTEXT.md`](../CONTEXT.md) (the glossary) |
| "Why was decision X made?" | The ADR that owns it - **follow a link to it, don't browse the folder**. ADRs are deep-dive decision records, one question each; the chronological record is [`decision-log.md`](./decision-log.md), indexed one line each in [`../CLAUDE.md`](../CLAUDE.md) |
| "How do I run / test / demo it?" | The root [`README`](../README.md) + the Commands block in [`../CLAUDE.md`](../CLAUDE.md) |

**About the ADRs**, since they are the folder that overwhelms: you almost never read them
front-to-back. They exist so that when some rule looks strange ("why is delete refused?", "why does
archive 404 the public page?"), one document explains that one call completely - every other doc
links into them at exactly the moment the question arises. Reading order for a newcomer is: this
file → `demo.md` → `architecture.md` → whatever your task links to.
