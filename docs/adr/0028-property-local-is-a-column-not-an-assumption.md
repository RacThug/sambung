# ADR-0028: Property-local is a column, not an assumption

- **Date**: 2026-07-21
- **Status**: Accepted
- **Issue**: #145 (inherited from #56, surfaced by the independent review of #38)
- **Builds on**: ADR-0025 (the import pipeline), ADR-0016 (the hand-rolled serializer), ADR-0008 (a pure resolver judges nothing)

## Context

`ical-parse.ts` took the leading `YYYYMMDD` of every DTSTART/DTEND and dropped whatever followed. For the all-day `VALUE=DATE` VEVENTs the three supported OTAs actually publish, that is right. For a **UTC-stamped** value it is not: `20260801T163000Z` is 23:30 on 1 August in Java but 00:30 on the 2nd in Bali, so the imported block landed a night early. Half-open ranges shift *both* edges, and `booking_no_overlap` then faithfully enforced the wrong nights - a calendar bug that fails silently, by one day, which is the worst way for a calendar bug to fail.

#38 shipped with this as a knowingly unmet acceptance criterion, because "property-local" was undefined in the data model: `property` carries `latitude`/`longitude` but nothing that says what local *means*. The first pass (2026-07-21) documented the limitation and left it. This ADR closes it.

Two facts reshaped the problem on the second look:

1. **The bug is a quarter the size the issue claimed.** RFC 5545 §3.3.5 gives a value three forms, and `splitLine` strips params before the date is read. A **floating** time is by definition observer-local, and the observer of a property calendar is the property. A **TZID**-qualified value's date part is already local to that zone. So `VALUE=DATE`, floating, and TZID were never wrong - only the UTC form was.
2. **Postgres cannot validate an IANA zone in a `CHECK`.** `AT TIME ZONE` is `STABLE`, not `IMMUTABLE`, so a constraint referencing it is rejected outright.

## Decision

**A `property.time_zone` column, drawn from a closed set, consulted only where a value genuinely lacks a date.**

- **`property.time_zone text NOT NULL DEFAULT 'Asia/Makassar'`**, with `CHECK (time_zone IN ('Asia/Jakarta','Asia/Makassar','Asia/Jayapura'))` - WIB / WITA / WIT - mirrored by `propertyTimeZoneSchema` in `@sambung/shared` (migration 0013).
- **Optional at create, editable via PATCH**, exactly like `deposit_pct`. The default backfills every existing row, all of which are Bali.
- **The zone is a required argument to the parse**: `parseCalendar(body, timeZone)`. It is consulted **only** for `Z`-suffixed values; the other three forms keep their date part verbatim.
- **`syncConnection` resolves the zone itself** via one `unit -> property` select, so the cron and "Sync now" cannot disagree about it.
- **A `TZID` naming a zone that is not the property's is reported, not converted** - `ParseResult.foreignTimeZones`, logged once per cycle by the importer.

## Why

**A closed set, because the alternative gives up the DB backstop on the one column that exists for correctness.** Every constrained column here is checked twice - `deposit_pct` by zod and by `property_deposit_pct_range` - on the principle that the app check is UX and the DB check is truth (invariant #5). Free IANA text cannot be checked in the DB at all, so a typo'd `Asia/Makasar` would sit happily in the row and throw later, inside a cron, far from whoever typed it. A lookup table seeded from `pg_timezone_names` would restore the gate but make validity depend on the host's tz database version, so dev and the VPS could disagree about what is storable. The closed set is the only option that keeps both halves. It also makes the UI a three-option select an owner can reason about rather than a four-hundred-entry combobox, and it makes listing a property outside Indonesia a migration - the right amount of friction for a product-scope decision.

**Defaulted, not required, because requiring it does not buy what it appears to.** A mandatory select is clicked through as fast as a default by an owner who does not know what a timezone is; what it reliably buys is friction on the highest-abandonment screen in the product. And a defaulted-but-wrong zone is not the same class of bug as no zone: it narrows the wrong-date window from eight hours to one.

| Zone setting | UTC hours yielding a wrong date |
|---|---|
| None (before this) | 16:00Z-23:59Z (8 hours) |
| WITA, property in Bali | none |
| WITA, property actually in Java or Papua | 1 hour |

**The zone is an argument to the parse, not a judgement withheld from it.** ADR-0008's resolvers stay pure because archived-ness is a *policy* applied downstream - the resolver could answer completely and declines to judge. That precedent does not transfer: `20260801T163000Z` **has no calendar date** until a zone is named, so the parser cannot answer at all. The zone is missing input, and input belongs in the signature. Keeping it out would have meant widening `ImportedEvent` - the module's stated trust boundary, "a validated `{uid, start, end}`" - into a union of un-localized shapes, for a case where three of four value forms need no localization at all. Required rather than optional, so a future caller cannot silently reintroduce the bug by omitting it.

**Only the UTC form is converted**, because the other three are right by construction and converting them would mean the *inverse* direction - wall-time to instant - which `Intl` does not offer and where DST gaps and doubled hours live. A general implementation would trade this off-by-one for a subtler one, to serve a case (an OTA publishing a Bali villa's calendar stamped in another zone) more hypothetical than the bug being fixed.

**`Intl.DateTimeFormat`, no dependency.** Instant to zone-local date is solved in the platform, and Node ships full ICU (workspace engines `>=20.9.0`). A datetime library would be a maintenance surface for one function. `formatToParts` rather than a locale's format string: `en-CA` renders ISO-ish today, but a locale's output is not a contract.

## Consequences

- **The remaining gap is loud instead of silent.** A `TZID` differing from the property's zone keeps its date part verbatim - behaviour unchanged - but the importer now WARNs once per cycle naming both zones. No supported OTA emits `TZID` on availability, so this is silent in normal operation and speaks only when the assumption above has broken. It is deliberately **not** a `sync_conflict`: ADR-0027 draws that line at "an operational conflict a human can fix in the real world", and a foreign timezone stamp is a defect in our assumptions, which belongs in a log.
- **An unusable zone is an unhealthy parse, not an exception.** `parseCalendar` validates the zone once per feed and returns `{ ok: false }` if it cannot be used, preserving the module's "never throws" guarantee - the connection is marked `error` and nothing is reconciled, rather than a `RangeError` escaping inside a cron. Constructing the formatter once per feed also keeps a 500-event calendar cheap.
- **`property_time_zone_known` joins the constraint map's silent partners.** Like `property_slug_format`, it guards a value the app has already validated, so it should never raise; if it does, some path bypassed `propertyTimeZoneSchema` - a bug, therefore a 500, not a mapped 409 (ADR-0012).
- **The zone is owner-facing only.** It appears in `PropertyResponse` and the PATCH body, and deliberately **not** in the public property payload: the funnel has no use for it, and a public projection stays as narrow as it can be (the `PublicPropertyRow` principle).
- **The stay itself stays timezone-free.** `check_in`/`check_out` remain `date` columns (invariant #4); the zone converts at the import boundary and is never carried into the ledger, so nothing downstream - availability, the exclusion constraint, the export feed - gains a timezone concept.
- **The `.ics` export is untouched.** It emits all-day `VALUE=DATE` from `date` columns, the one form that needs no zone (ADR-0016).
- **ADR-0027's Consequences carried this as an open residual** and now points here. #145 is closed; the follow-up condition it recorded ("reopen when a channel emitting timed availability is added") is moot, because the timed path works.
- **Widening beyond Indonesia costs a migration** - the `CHECK`, the zod enum, and the UI labels. Accepted: the PRD is Bali, and a property in Singapore is a product decision that deserves a deliberate change rather than a free-text field.
