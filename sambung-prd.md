# Sambung — Product Requirements Document (PRD)

> **Codename:** `Sambung` (Indonesian: *to connect / link*) — placeholder, rename freely.
> **Type:** Portfolio showcase project (multi-tenant SaaS) — built to demonstrate full-stack engineering depth to prospective clients.
> **One-liner:** A direct-booking engine + lightweight channel manager that lets a Bali villa/guesthouse owner take commission-free direct bookings while keeping their OTA calendars in sync.
> **Status:** Draft v1 · Owner: RacThug (CEO / WHAT-WHY) · Builder: Claude Code (dev team)

---

## 1. Why this project exists

### 1.1 Problem
Small-to-mid Bali accommodation owners (villas, guesthouses, homestays) are squeezed from two sides in 2026:

- **OTA fees eat margin.** Airbnb's host-only model now charges ~15.5% per booking. Owners want more direct bookings to escape this.
- **Direct booking is realistic, not fantasy.** Roughly half of guests still visit a property's own website after finding it on an OTA — so a credible direct channel actually converts.
- **Regulatory pressure rewards "verified" presence.** Bali's 2026 enforcement (NIB / KBLI 55193 / valid licenses required to stay listed) makes owners more conscious of a legitimate, professional digital presence.
- **Double-booking is the nightmare.** The moment you sell directly *and* on OTAs, calendars drift and you risk overbooking. This is exactly the problem a channel manager solves.

### 1.2 Why it's a strong portfolio piece
It forces demonstration of the hard skills clients pay for: **multi-tenancy, calendar/availability logic, third-party sync, payment integration, role-based access, and a polished public-facing booking flow.** It is complex enough to be impressive, but — because it's a showcase, not a live 24/7 product — the complexity is an asset rather than a maintenance burden.

### 1.3 Cost constraint (hard requirement)
v1 must be buildable and demoable with **zero recurring paid dependencies**:
- OTA sync via **iCal** (free, industry-standard for small operators)
- Payments via **Midtrans/Xendit sandbox** (test mode, free)
- DB on **Supabase or Neon free tier**
- Hosting on **Vercel + Railway/Render free tiers**

---

## 2. Goals & non-goals

### 2.1 Goals
- G1 — A single owner can manage **multiple properties** from one account (true multi-tenant).
- G2 — Each property has a **public booking page** where a guest can check availability and book directly.
- G3 — **No double-booking:** a direct booking blocks the dates everywhere; an OTA booking (imported via iCal) blocks the direct calendar.
- G4 — A guest can **pay a deposit/full amount** through a sandbox payment flow and receive confirmation.
- G5 — The whole thing **demos cleanly in under 5 minutes** to a prospective client.

### 2.2 Non-goals (explicitly out of scope for v1)
- Real-time OTA API push (Booking.com Connectivity, Airbnb API) — gated, expensive, slow approval. iCal is enough.
- Dynamic pricing / yield management.
- Multi-currency payouts, real money movement, accounting.
- Native mobile app.
- Guest review aggregation.
- Housekeeping/staff task management (candidate for v2).

---

## 3. Target users & personas

| Persona | Role | Needs |
|---|---|---|
| **Wayan — the owner** | Tenant admin | Manage properties, see all bookings, connect OTA calendars, get paid directly |
| **Komang — property manager** | Staff (scoped) | Day-to-day reservations for assigned properties only; cannot touch billing/settings |
| **Guest (e.g. Asian/EU traveler)** | Public | Browse a property, check dates, book, pay deposit, get confirmation — in their language |

> Persona note: with Asian arrivals rising sharply, the guest-facing site should support **EN / ID / 中文** from day one. This is a cheap feature with high demo value.

---

## 4. Core user flows

### 4.1 Owner onboarding
1. Sign up → create tenant (owner account).
2. Add a property (name, location, photos, description, amenities, optional NIB/license field → "Verified" badge).
3. Add unit(s)/room type(s) with base price and capacity.
4. Paste OTA iCal export URLs (Airbnb, Booking.com, Vrbo) → system imports blocked dates.
5. Copy the property's **public booking page link** + its **export iCal URL** (paste back into OTA to close the loop).

### 4.2 Guest direct booking
1. Open public property page (chosen language).
2. Pick check-in/check-out → system shows availability + total price.
3. Enter guest details → choose pay deposit or full.
4. Redirect to Midtrans/Xendit sandbox → pay → return to confirmation.
5. Receive email + WhatsApp (wa.me deeplink) confirmation. Dates instantly blocked across all calendars.

### 4.3 Owner booking management
1. Dashboard shows unified calendar across all properties (direct + OTA-imported, color-coded by source).
2. Drill into a reservation: guest info, status, payment status, source.
3. Manually create/block dates (walk-in, maintenance).
4. Filter/search reservations; export a simple CSV.

---

## 5. Functional requirements

Each requirement has an ID and acceptance criteria so it maps cleanly to a GitHub Issue.

### 5.1 Auth & multi-tenancy
- **FR-AUTH-1** — Email/password signup creates a Tenant + owner User.
  - *AC:* New owner lands on empty dashboard scoped to their tenant; cannot see other tenants' data.
- **FR-AUTH-2** — Owner can invite a Staff user scoped to specific properties.
  - *AC:* Staff sees only assigned properties; billing/settings routes return 403.
- **FR-AUTH-3** — All data access is tenant-scoped at the query layer (and via RLS if Supabase).
  - *AC:* A crafted request with another tenant's IDs returns 404/403, never data.

### 5.2 Property & inventory
- **FR-PROP-1** — CRUD properties (name, address, geo, description, photos, amenities, license/NIB field).
  - *AC:* Property with ≥1 photo + price renders a complete public page.
- **FR-PROP-2** — CRUD units/room types with base nightly price, max guests, min-stay.
  - *AC:* Availability + pricing reflect the unit's rules.
- **FR-PROP-3** — Optional "Verified" badge shown when license field is filled.
  - *AC:* Badge appears on public page only when NIB/license present.

### 5.3 Availability & calendar (the core)
- **FR-CAL-1** — A single source-of-truth availability calendar per unit.
  - *AC:* A confirmed booking marks those nights unavailable everywhere.
- **FR-CAL-2** — Pricing calc for a date range (base price × nights, min-stay enforced).
  - *AC:* Selecting invalid range (below min-stay / overlapping booked night) is rejected with a clear message.
- **FR-CAL-3** — Unified multi-property calendar view for the owner, color-coded by source (direct / Airbnb / Booking / manual).
  - *AC:* Owner can visually spot a clash; clashes are prevented at write time anyway.

### 5.4 Channel sync (iCal — the "channel manager")
- **FR-SYNC-1** — Import: per channel connection, store an iCal URL; scheduled job (e.g. every 30 min) pulls and blocks imported dates.
  - *AC:* Adding a busy range in an external test iCal blocks those nights within one sync cycle; a manual "Sync now" button forces it.
- **FR-SYNC-2** — Export: each unit exposes an iCal feed of all confirmed bookings (direct + imported).
  - *AC:* Subscribing to the export URL in an external calendar shows all blocked dates.
- **FR-SYNC-3** — Sync status & last-synced timestamp visible per channel; failures surfaced.
  - *AC:* A broken iCal URL shows an error state, not a silent fail.

### 5.5 Direct booking & payments
- **FR-BOOK-1** — Public booking flow: availability check → guest details → booking record (status `pending_payment`).
- **FR-PAY-1** — Sandbox payment (Midtrans Snap or Xendit). Deposit % configurable per property.
  - *AC:* Successful sandbox payment moves booking to `confirmed` and blocks dates; failure leaves dates open.
- **FR-PAY-2** — Webhook handling for async payment status (idempotent).
  - *AC:* Duplicate webhook delivery does not double-confirm or double-block.

### 5.6 Notifications
- **FR-NOTIF-1** — Email confirmation to guest + owner on `confirmed` (free email provider / Resend free tier or SMTP).
- **FR-NOTIF-2** — WhatsApp confirmation via `wa.me` prefilled deeplink (no paid WA API in v1).
  - *AC:* Confirmation page shows a "Send WhatsApp confirmation" button with prefilled message.

### 5.7 Internationalization
- **FR-I18N-1** — Public site supports EN / ID / ZH with a language switcher; persisted per visitor.
  - *AC:* Switching language translates UI strings + date formatting; booking still works end-to-end.

---

## 6. Architecture & tech stack

Aligns with your existing stack (Next.js + NestJS + TypeScript monorepo, PostgreSQL).

### 6.1 Monorepo layout
```
sambung/
├── apps/
│   ├── web/          # Next.js — guest booking site + owner dashboard
│   └── api/          # NestJS — REST API, sync jobs, webhooks
├── packages/
│   ├── db/           # Prisma schema + client (shared)
│   ├── shared/       # shared types, zod schemas, constants
│   └── config/       # eslint/tsconfig/tailwind presets
├── turbo.json
└── pnpm-workspace.yaml
```
- **Monorepo tooling:** pnpm workspaces + Turborepo.
- **Web:** Next.js (App Router), Tailwind, next-intl for i18n. Owner dashboard + public site in one app (separate route groups) to keep it lean.
- **API:** NestJS. Modules mirror domains: `auth`, `tenant`, `property`, `availability`, `channel-sync`, `booking`, `payment`, `notification`.
- **DB:** PostgreSQL via **Prisma** (best DX for a solo dev; TypeORM is the fallback if you prefer staying NestJS-native). Hosted on Supabase or Neon.
- **Auth:** JWT (access + refresh) issued by NestJS, OR Supabase Auth if you want RLS for the tenant-isolation story. *Decision needed — see §10.*
- **Jobs:** NestJS `@nestjs/schedule` cron for iCal pull. No external queue needed at this scale.
- **iCal:** `node-ical` (parse imports) + `ics` (generate exports).
- **Payments:** Midtrans Snap (sandbox) — well-documented for Indonesia. Xendit as alternative.
- **Email:** Resend free tier or Nodemailer+SMTP.

### 6.2 Multi-tenancy model
Shared database, **`tenant_id` column on every tenant-owned row** (row-level scoping). Enforced by:
1. A NestJS guard/interceptor that injects `tenant_id` from the authenticated user into every query.
2. (If Supabase) Postgres **RLS policies** as defense-in-depth — also a great thing to *show* clients.

This is the simplest robust model for a solo dev; pool model, not silo. Document the choice in the README as a deliberate trade-off.

### 6.3 Data model (sketch)
```
Tenant            id, name, created_at
User              id, tenant_id, email, password_hash, role(owner|staff)
UserProperty      user_id, property_id            # staff scoping
Property          id, tenant_id, name, address, geo, description,
                  amenities[], photos[], license_no(nullable)
Unit              id, property_id, name, base_price, max_guests, min_stay
Booking           id, unit_id, tenant_id, source(direct|airbnb|booking|manual),
                  guest_name, guest_contact, check_in, check_out,
                  total_price, status(pending_payment|confirmed|cancelled)
ChannelConnection id, unit_id, channel, import_ical_url, last_synced_at, status
Payment           id, booking_id, provider, amount, status, raw_payload(jsonb)
```
> Availability is *derived* from `Booking` rows (incl. imported + manual blocks) rather than stored separately — single source of truth, fewer sync bugs.

### 6.4 Deployment
- `web` → Vercel.
- `api` → Railway / Render / Fly.io free tier.
- `db` → Supabase / Neon.
- Seed script with 2 demo tenants, 3 properties, sample bookings → instant demo state.

---

## 7. Milestones (maps to workplan.md)

| Phase | Theme | Outcome |
|---|---|---|
| **M0** | Scaffolding | Monorepo, DB schema, auth, seed data, CI |
| **M1** | Inventory | Property + unit CRUD, photo upload, public page renders |
| **M2** | Availability + direct booking | Calendar logic, pricing, booking flow (no payment yet) |
| **M3** | Payments | Sandbox payment + webhook → `confirmed`, notifications |
| **M4** | Channel sync | iCal import job + export feed + sync status UI |
| **M5** | Polish + i18n + demo | Unified calendar, EN/ID/ZH, Verified badge, demo script, README |

Each phase = one sprint in `workplan.md`. Ship M1–M3 first if you need a demo fast; M4 is the "wow" differentiator but can come after.

---

## 8. Success criteria (portfolio lens)

- **Demoable:** owner adds property → guest books + pays (sandbox) → dates block on an external calendar, live, in <5 min.
- **Proves to clients:** multi-tenancy, third-party integration, payment handling, RBAC, i18n, clean public UX.
- **Clean repo:** README with architecture diagram + the "why" behind each major decision (this is what senior reviewers actually read).
- **No paid dependency** required to run it.

---

## 9. Risks & assumptions

- **R1 — iCal lag:** iCal sync is not instant (poll-based). *Mitigation:* document it honestly; OTAs themselves work this way for small operators. Add "Sync now".
- **R2 — Scope creep:** channel managers balloon fast. *Mitigation:* §2.2 non-goals are firm; resist real OTA API in v1.
- **R3 — Payment webhook reliability:** *Mitigation:* idempotent handlers (FR-PAY-2), reconcile on confirmation page load.
- **A1 —** Demo uses test iCal feeds (a public Google Calendar exported as iCal works as a stand-in for an OTA).

---

## 10. Open decisions (need your call)

1. **Auth approach:** NestJS-issued JWT (more "look I built it myself" cred) **vs** Supabase Auth + RLS (faster, stronger tenant-isolation demo). Recommendation: **JWT + RLS-style tenant guard** if you want to showcase backend skill; Supabase Auth if you want speed.
2. **ORM:** Prisma (recommended for DX) vs TypeORM (NestJS-native, matches your day-job comfort).
3. **Single Next.js app** (dashboard + public site, route groups) vs **two apps**. Recommendation: single app for v1.
4. **Name:** keep `Sambung` or rebrand?

---

## 11. Next deliverables (on request)
- `CLAUDE.md` — operating contract for Claude Code (stack, conventions, guardrails, the two-session review protocol).
- `workplan.md` — sprint board mirroring §7 milestones.
- **GitHub Issues seed** — one issue per FR with acceptance criteria, labeled by milestone.
