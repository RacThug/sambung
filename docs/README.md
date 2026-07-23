# Sambung — Documentation

Source-of-truth design docs for Sambung. **Read the relevant one before touching that area.**
These are written to be both human- and AI-readable: an agent should load the doc for the
subsystem it's working on before proposing changes.

| Doc | Read it before… | Covers |
|-----|-----------------|--------|
| [`prd.md`](./prd.md) | …deciding *what* to build or whether something is in scope | Why the project exists, requirements, acceptance criteria, milestones |
| [`db-design.md`](./db-design.md) | …writing a migration, query, or anything touching data integrity | Schema, `daterange`/GiST exclusion constraint, integrity rules (SQL-first, teaching edition) |
| [`architecture.md`](./architecture.md) | …wiring FE↔BE, adding a module, or moving data across the stack | FE/BE split, module layout, data flows, the API boundary |
| [`sitemap.md`](./sitemap.md) | …getting oriented: which routes exist and how they wire together | Every SPA page **and** API endpoint, a route-tree diagram, FE↔API traceability; code-verified so it can't drift (ADR-0036) |
| [`api-spec.md`](./api-spec.md) | …adding or changing an endpoint | Every REST endpoint M0-M5: path, shapes, behavior, errors, conventions |
| [`page-spec.md`](./page-spec.md) | …adding or changing a page/route | Every SPA page: purpose, route + URL state, endpoints consumed, states |
| [`design-system.md`](./design-system.md) | …building or styling any UI | Brand (palette, type, wordmark), semantic tokens, the two-surface component doctrine (ADR-0007) |
| [`demo.md`](./demo.md) | …showing the product to somebody | The five-minute scripted walkthrough (PRD §8 / G5): prerequisites, four acts with exact URLs and labels, encores, what is deliberately out of scope |
| [`r2-cutover.md`](./r2-cutover.md) | …pointing production photo storage at Cloudflare R2 (or Garage on the VPS) | The dashboard steps, the `storage:doctor` probe that verifies them, and what R2 does *not* document (ADR-0029) |
| [`og-verification.md`](./og-verification.md) | …proving a `/p/:slug` link previews as a real card | Running the real Caddy config locally, the `og:doctor` probe and its baseline, the free quick-tunnel recipe for the manual crawler pass (ADR-0035) |

## How these relate

- **`prd.md`** answers *what & why* — the product contract the owner (RacThug) owns.
- **`db-design.md`** and **`architecture.md`** answer *how* — the engineering contract the builder owns.
- The standing engineering rules (invariants, boss fights, guardrails) live in [`../CLAUDE.md`](../CLAUDE.md),
  which links back into these docs by section.

## Conventions

- The DB and architecture docs are **teaching editions**: every decision comes with its *why*,
  because Sambung is a learning project. Preserve that voice when extending them.
- Cross-reference by section number (e.g. "DB doc §4.3") rather than copying rules between files —
  keep a single source of truth per fact.
