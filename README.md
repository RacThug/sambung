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

- [`docs/prd.md`](./docs/prd.md) — product requirements & acceptance criteria
- [`docs/db-design.md`](./docs/db-design.md) — schema, constraints, rationale
- [`docs/architecture.md`](./docs/architecture.md) — FE/BE split, modules, data flows
- [`docs/README.md`](./docs/README.md) — documentation index
- [`CLAUDE.md`](./CLAUDE.md) — engineering operating contract

## Getting started

```bash
git config core.hooksPath .githooks          # one-time: enable the git hooks
pnpm install
docker compose up -d                          # local Postgres (migrate/seed/db tests)
pnpm dev                                       # web + api (turbo)
pnpm --filter @sambung/db db:migrate          # apply migrations (incl. RLS policies)
pnpm --filter @sambung/db db:setup-role       # create the non-owner app role (RLS)
pnpm --filter @sambung/db db:seed             # 2 tenants, 3 properties, sample bookings
pnpm lint && pnpm typecheck && pnpm test
```

## Contributing / Git workflow

Work happens on branches, never directly on `main` (GitHub Flow):

```bash
git switch -c m0/your-task     # branch off main: m<milestone>/<short-task>
# ...commit your work...
git push -u origin m0/your-task
gh pr create --base main       # open a PR, then squash-merge
```

A `pre-push` hook (1) blocks accidental direct pushes to `main`/`develop`, and (2) runs
`pnpm lint && pnpm typecheck` as a local quality gate (our free replacement for cloud CI).
Enable it once per clone with the `git config core.hooksPath .githooks` command above.
DB-backed tests need Docker, so run `pnpm test` yourself before opening a PR.
