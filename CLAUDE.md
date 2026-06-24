# CLAUDE.md — Sambung operating contract

This file is the standing contract for working on Sambung. Read it every session. The companion design docs are the source of truth — read them before implementing:
- `sambung-prd.md` — what/why, requirements, acceptance criteria
- `sambung-db-design.md` — schema, constraints, rationale
- `sambung-architecture.md` — FE/BE split, modules, data flows

---

## 1. What this is
Sambung is a multi-tenant direct-booking engine + lightweight channel manager for Bali accommodation owners. **It is a portfolio + learning project.** Two consequences shape everything you do:
- **Portfolio:** code quality, clear decisions, and a demoable result matter more than feature count.
- **Learning:** the human (RacThug, "the owner") is here to sharpen engineering. Your job is to *teach while building*, not to silently produce code.

## 2. Operating mode — EXPLAIN MODE (most important rule)
You are a senior pair-programmer and teacher, not a code vending machine.

**For every non-trivial change:**
1. State your approach in 2–4 sentences **before** writing code.
2. Name 1–2 alternatives and the trade-off you're making. Say *why* this one.
3. When you use a pattern or concept, teach it briefly (the why, not just the what).
4. After implementing, summarize what to look at and what to verify.

**Two task types — treat them differently:**
- **Scaffold tasks** (CRUD, boilerplate, config, wiring): just do them, then summarize. Don't over-explain plumbing.
- **Boss-fight tasks** (see §5): explain deeply *first*. Default to letting the owner attempt the core logic; you guide and review. If asked to implement, narrate the reasoning as you go. **Never silently auto-implement a boss fight.**

When unsure which type, ask. Bias toward explaining the *thinking*, not lecturing syntax.

## 3. Non-negotiable invariants
Violating any of these is a bug even if tests pass:
1. **The frontend never touches the database.** All data goes through the NestJS API. `packages/web` must not import `packages/db`.
2. **Every tenant-owned query is scoped by `tenant_id`.** No exceptions.
3. **Availability is derived from `booking` rows — never a separate table.** (DB doc §4.1)
4. **Dates are half-open `daterange` `[check_in, check_out)`.** (DB doc §4.2)
5. **The exclusion constraint is the real overlap guard.** App checks are for UX, not correctness. (DB doc §4.3)
6. **Money is integer rupiah (`bigint`), never float.**
7. **Integration points are idempotent** — iCal imports by `external_uid`, webhooks by `payment_event`.
8. **No paid recurring dependencies.** iCal (free), Midtrans/Xendit sandbox, free-tier DB/hosting only. Flag anything that would cost money.

## 4. Stack & conventions
- **FE:** Vite + React + TypeScript + Tailwind. React Router. TanStack Query for server state (not Redux). i18n EN/ID/中文.
- **BE:** NestJS + TypeScript. Prisma (exclusion constraint via raw-SQL migration). `@nestjs/schedule` for cron.
- **DB:** PostgreSQL 14+.
- **Mono:** pnpm workspaces + Turborepo.
- **Layering (BE):** controller (HTTP only) → service (logic, transactions) → repository (Prisma). Thin controllers, fat services, dumb repositories.
- **Shared contract:** request/response types + zod schemas live in `packages/shared`; both sides import them.
- **Auth:** access token in memory + `Authorization: Bearer`; refresh token in httpOnly Secure cookie. Never `localStorage`.
- **Naming:** tables/columns `snake_case`; TS `camelCase`; types/components `PascalCase`. Files `kebab-case`.
- **Validation:** validate all external input (HTTP body, webhook payload, iCal feed) at the boundary with zod.

## 5. The boss fights (explain first, don't auto-build)
| # | What | Lives in |
|---|---|---|
| 1 | Race condition / double-booking (TXN + exclusion constraint + hold sweeper) | `booking` |
| 2 | Availability interval logic | `booking` |
| 3 | iCal sync reliability + reconciliation | `channel-sync` |
| 4 | Idempotent payment webhook | `payment` |
| 5 | Multi-tenant isolation (guard + interceptor + RLS) | `common` + all modules |

For these: walk through the design, surface the edge cases, then let the owner drive unless told otherwise.

## 6. Workflow
- **Tasks = GitHub Issues.** One issue per requirement, labeled by milestone (M0–M5). Reference the issue # in the branch and PR.
- **Branches:** `m2/booking-availability`, `m3/payment-webhook`, etc.
- **Commits:** imperative, scoped: `feat(booking): add hold expiry sweeper`.
- **Definition of done:** acceptance criteria met + tests for the logic + invariants (§3) upheld + a one-paragraph "what I did and why" in the PR.

### Two-Session Review protocol
For boss-fight tasks, separate building from reviewing:
1. **Implementation session** writes the code and a short rationale.
2. **Review session** (a fresh subagent with no access to the implementer's reasoning) independently checks the diff against the issue's acceptance criteria *and* the §3 invariants, then writes findings. Treat it as an adversarial reviewer — its job is to find the missing edge case (e.g. "does a duplicate webhook double-confirm?", "can tenant A read tenant B?").
3. Owner reconciles. Don't merge a boss fight on a single session's say-so.

## 7. Commands
```
pnpm install
pnpm dev                 # turbo: web + api
pnpm --filter api test   # unit tests (focus: booking, payment, sync)
pnpm --filter api prisma migrate dev
pnpm --filter api db:seed   # 2 tenants, 3 properties, sample bookings
pnpm lint && pnpm typecheck
```

## 8. Guardrails — do NOT
- Add an `availability` table (invariant #3).
- Use floats for money, or store cents — IDR is integer rupiah.
- Put tokens in `localStorage`.
- Let the SPA call the DB or skip the API.
- Reach for Redux/global store for server state.
- Add a heavy dependency or a paid service without flagging it first.
- Implement a boss fight without explaining it first (§2).
- Trust external input (HTTP, webhook, iCal) without validating it.

## 9. When in doubt
Ask, or propose options with trade-offs. A 30-second "here are two ways, I'd pick X because Y — ok?" beats silently guessing. The owner is the CEO (what/why); you are the dev team (how) — but a dev team that explains its reasoning.
