# EARS spec - Date-based pricing (PRD-product P0-2)

**Status:** agreed (owner, 2026-08-17) · **Traces to:** [`../prd-product.md`](../prd-product.md) P0-2,
page spec [`../pages/app-properties-propertyId.md`](../pages/app-properties-propertyId.md) (P0-2
amendment), migration `0017_unit_price_override.sql`, shared contract
`packages/shared/src/price-override.ts`.

> **Format.** EARS (Easy Approach to Requirements Syntax): each requirement is one testable sentence -
> ubiquitous ("the system shall"), event-driven (WHEN), state-driven (WHILE), or unwanted-behaviour
> (IF/THEN). The **Verified by** column names the test that makes the sentence falsifiable; a row with
> no test is a claim, not a requirement. UI behaviour lives in the page spec, not here - this file
> covers the system.

## 1. Pricing (the quote)

| ID | Requirement | Verified by |
|---|---|---|
| PR-01 | The system shall price each night of a stay at the override covering that night, else at the unit's `basePriceIdr`. | shared `availability.test.ts` (quoteTotalIdr cases) |
| PR-02 | WHEN a quote is computed for a half-open window `[from, to)`, the system shall sum nightly prices over exactly `countNights(from, to)` nights - the checkout day is never priced. | same |
| PR-03 | The system shall produce one total for one stay wherever it is asked: the public availability read, the guest booking write, and the owner walk-in all price through the single `quote()` authority. | api `units/price-overrides.spec.ts` (public quote + guest write price identically) |
| PR-04 | WHILE a booking exists, the system shall never re-price it: `total_price_idr` is a snapshot at creation, and no override create/delete may change what was sold. | db `price-override.test.ts` ("config, not ledger") + existing booking specs |
| PR-05 | The system shall compute the Deposit share (ADR-0015) from the snapshotted total, unchanged by this feature. | existing `deposit.spec.ts` |
| PR-06 | The system shall keep every nightly price - base or override - within `[1..1e9]` (`MAX_NIGHTLY_RATE_IDR`), so a 366-night quote can never overflow `toRupiah`. | shared `price-override.test.ts` (zod layer) + db `price-override.test.ts` (CHECK layer) |

## 2. Override lifecycle (owner/staff API)

| ID | Requirement | Verified by |
|---|---|---|
| OV-01 | WHEN `POST /units/:unitId/price-overrides` is called with a valid body, the system shall store the override iff it overlaps no existing override on that unit. | api `units/price-overrides.spec.ts` |
| OV-02 | IF the new range overlaps an existing override, THEN the system shall answer `409 {code: "price_override_overlap"}`, byte-identical whether the app pre-check or the `price_override_no_overlap` exclusion constraint refused (§5.3). | api `units/price-overrides.spec.ts` (pre-check + jest-spy constraint-force, bodies byte-equal) |
| OV-03 | The system shall treat override ranges as half-open `[from, to)`: back-to-back seasons sharing a boundary date do not clash. | db `price-override.test.ts` (changeover case) |
| OV-04 | IF the body carries an unknown key, an inverted range, an impossible calendar date, or a price outside `[1..1e9]`, THEN the system shall answer 400 naming the field. | shared `price-override.test.ts` + ADR-0031 drift guard |
| OV-05 | WHEN `GET /units/:unitId/price-overrides` is called, the system shall return the unit's overrides sorted by `from`. | api `units/price-overrides.spec.ts` |
| OV-06 | WHEN `DELETE /price-overrides/:id` is called for an existing override, the system shall delete it; a repeat call shall answer 404 (idempotent from the caller's view: already gone = gone). | api `units/price-overrides.spec.ts` |
| OV-07 | The system shall NOT gate override writes on archived state: pricing a retired unit is harmless (the §5.3 booking chokepoint is what guards selling), and the same rule already governs unit field edits. | api `units/price-overrides.spec.ts` (archived-unit control case) |

## 3. Isolation (invariant #2, ADR-0032)

| ID | Requirement | Verified by |
|---|---|---|
| ISO-01 | The system shall scope every override read and write by `tenant_id` under RLS; a cross-tenant id shall answer 404, never 403. | db `rls.test.ts` (table-driven, both axes) + api `units/price-overrides.spec.ts` (cross-tenant 404s) |
| ISO-02 | WHILE the caller is Staff, the system shall expose overrides only under assigned properties, enforced by the policy's `app_property_visible` term - not by any route code. | db `rls.test.ts` (staff branch) |
| ISO-03 | The system shall make a cross-tenant override row unrepresentable via `price_override_unit_tenant_fk`, independent of RLS. | db `tenant-consistency.test.ts` |
| ISO-04 | IF no tenant GUC is set (cold or pool-reset connection), THEN every override query shall return zero rows - fail closed on both axes. | db `rls.test.ts` (fail-closed loop) |
| ISO-05 | Both Owner and Staff may manage prices for units they can see; no `@Roles` guard applies (the ADR-0032 verb line reserves tenant-shape verbs, and pricing an assigned unit is operating it). | db `rls.test.ts` (staff sees assigned overrides) + the routes carry no `@Roles` guard; a staff HTTP write is deliberately NOT re-proven here - the RLS layer is the authority |

## 4. Out of scope (deferred by name, PRD-product P0-2)

Rate plans, occupancy-based pricing, LOS rules, recurring weekend rules, editing an override in place
(remove-then-add), calendar-visual price editing, per-night prices in the guest picker, and a computed
"from Rp N" headline on `/p/:slug` (the base price stays the headline; helper copy documents "base =
your everyday price").
