# Sambung

A multi-tenant **direct-booking engine** + lightweight **channel manager** for Bali accommodation owners. Built as a portfolio + learning project.

## What it does

- **Direct bookings** without per-reservation OTA commissions.
- **Channel sync** via iCal (free) to keep availability consistent across listings.
- **Payments** through Midtrans/Xendit sandbox, with idempotent webhooks.
- **Multi-tenant** isolation so each owner's data stays scoped to their tenant.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Vite + React + TypeScript + Tailwind, React Router, TanStack Query, i18n (EN/ID/中文) |
| Backend | NestJS + TypeScript, Prisma, `@nestjs/schedule` |
| Database | PostgreSQL 14+ (half-open `daterange`, exclusion constraint for overlap safety) |
| Monorepo | pnpm workspaces + Turborepo |

## Core invariants

- The frontend never touches the database — all data flows through the NestJS API.
- Every tenant-owned query is scoped by `tenant_id`.
- Availability is **derived from `booking` rows**, never stored in a separate table.
- The DB exclusion constraint is the real double-booking guard; app checks are UX-only.
- Money is integer rupiah (`bigint`), never float.

## Design docs

- [`sambung-prd.md`](./sambung-prd.md) — product requirements & acceptance criteria
- [`sambung-db-design.md`](./sambung-db-design.md) — schema, constraints, rationale
- [`sambung-architecture.md`](./sambung-architecture.md) — FE/BE split, modules, data flows
- [`CLAUDE.md`](./CLAUDE.md) — engineering operating contract

## Getting started

```bash
pnpm install
pnpm dev                 # web + api (turbo)
pnpm --filter api prisma migrate dev
pnpm --filter api db:seed
pnpm lint && pnpm typecheck
```
