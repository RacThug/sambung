# ADR-0012: A 409 carries a code, not a sentence

- **Date**: 2026-07-19
- **Status**: Accepted
- **Issue**: #82 (deferred out of #80)
- **Builds on**: #80 (the constraint name → response map + the `DbErrorInterceptor`), api-spec §5.3 (both layers indistinguishable), §8.6 (a wire enum lives in `packages/shared`, pinned by a test), #71 (the shared `FormField`, so field-level copy has a home)

## Context

api-spec §8.2 promises: *"invalid transitions and overlaps are 409s with stable machine-readable slugs; clients switch on those, not prose."* Half of that shipped. #80 built the map that turns a constraint **name** into the response it means (`booking_no_overlap` → `409 {reasons:['overlap']}`), and the booking write and the cancel FSM already answered with structured, machine-readable bodies (`reasons`, `status`). But the wire format itself was left alone, so two conventions coexisted:

- **Structured, slug-bearing:** `datesUnavailable` → `{ …, message, reasons }`, `bookingNotCancellable` → `{ …, message, status }`. The client switches on the typed field.
- **Prose-only:** `emailTaken` → `{ …, message: 'Email already registered' }`; the delete guard → `{ …, message: 'Cannot delete: this unit has 2 bookings - …' }`. The client had nothing to switch on but the HTTP status, and the web *rendered the server's sentence directly* (`property-edit-page`, `units-section`).

Two conventions split by which layer refused is exactly what §5.3 forbids ("the client cannot tell, and must not care"). It also blocks two things concretely: **i18n** (M5, EN/ID/中文) - server prose can't be translated in the browser, so every user-visible string that originates in the API is an i18n blocker - and **drift** - a delete guard's `count` welded into an English sentence is unreadable as data, and a slug typed `overlap` on one side and `overlapping` on the other fails silently, the same class of bug the `booking_source` enum drift (§8.6) taught us to design out.

The open question the issue names: what is the body shape? `message: 'email_taken'` (the slug *is* the message), or a dedicated field - `{ code: 'email_taken', … }` - with typed detail beside it?

## Decision

**Every 409, whichever layer produces it, carries a machine-readable `code` slug in a dedicated field; typed detail rides in sibling fields; `message` stays a human default the web never renders.**

The body is `{ statusCode, error, code, message, ...detail }`:

- **`code`** - a slug from `conflictCodeSchema`, a closed `z.enum` in `packages/shared/src/conflict.ts` imported by **both** sides. The set: `email_taken`, `unit_name_taken`, `property_has_bookings`, `unit_has_bookings`, `dates_unavailable`, `booking_not_cancellable`.
- **typed detail** - per code, in its own field: the delete guards' `count: number`, `dates_unavailable`'s `reasons: BookingRefusalReason[]`, `booking_not_cancellable`'s `status: BookingStatus`. `conflict.ts` models this as a discriminated union (`conflictBodySchema`) on `code`, so parsing a body narrows its detail.
- **`message`** - a human-readable default, kept for logs/observability. The web **never** renders it; it switches on `code` and composes its own copy (`describeConflict`, a `switch` over the shared union - a new slug without copy is a compile error).

One builder (`conflict(code, message, detail)`) stamps the shape, so no factory can forget the slug or diverge on the envelope. `apps/api` - the one workspace that imports both the factories and the shared schema - pins them together with a test (`conflicts.spec.ts`), exactly as §8.6 pins a wire enum to its pgEnum.

**Shape chosen: a dedicated `code`, not the slug-in-`message`.** The two already-correct errors put their machine field (`reasons`/`status`) *beside* a human `message`; `code` generalizes that working pattern to all 409s rather than overwriting the prose. It keeps `code` (machine identity, a closed set) and `message` (human default, an open string) as separate concerns - overloading one field to be both is what produced the prose-in-a-switchable-field mess in the first place. It also loses no information (logs keep a sentence) and matches the mainstream `code` + `message` convention a client author reads without a doc. The cost - §8.2 literally said "slug in `message`" - is paid once, here, by refining §8.2 to name `code`.

## Why

**One definition of "taken", one shape for "refused".** §5.3's guarantee - a racing constraint and an app-level pre-check are byte-identical to the client - already holds for the mapped half because both throw the *same factory*. Extending the slug convention to the prose-only half is what makes the guarantee true across the whole surface instead of half of it: a duplicate email from the pre-check and from the citext UNIQUE are the same `{code:'email_taken', …}` body, and the §5.3 test still proves it by deep-equality.

**The count is data, so it must survive as data.** `Cannot delete: this unit has 2 bookings` is a number a human can read and a machine cannot. `{code:'unit_has_bookings', count:2}` is the same fact the web can pluralize, localize, and render where *it* decides - on a banner, beside a button - without parsing English. Property and unit are distinct slugs (not one `has_bookings` + a noun the web infers) so the copy names the right thing by the contract, not by context.

**The web owns copy, or i18n is impossible.** The moment a user-visible string is minted in the API, it's frozen in one language. Pushing all copy to `describeConflict` puts every conflict sentence in one browser-side module - the single place M5 localizes - and the exhaustive `switch` over the shared union means the contract and the copy map can't silently diverge: add a slug, and the web stops compiling until it says what that slug reads like.

**A closed enum in `packages/shared`, or drift is invisible.** The slug is a client contract. Housing it as a `z.enum` both sides import makes a rename a compile error on the reader and the writer at once - the enum-drift lesson from §8.6, applied to conflicts.

## Consequences

- **`conflicts.ts` is the whole 409 vocabulary, in one file.** The two delete guards move out of inline `new ConflictException('Cannot delete: …')` in the services into `propertyHasBookings(n)` / `unitHasBookings(n)` factories, joining `emailTaken` / `unitNameTaken` / `datesUnavailable` / `bookingNotCancellable`. Every 409 the app throws now flows through one builder.
- **`ApiError` grows a `body`.** The web client keeps the raw parsed envelope so `conflictOf(error)` can read `code` + detail; before, `ApiError` surfaced only `status`/`message`/`fieldErrors` and the structured payload was thrown away.
- **Four web surfaces stop rendering server prose:** `register-page` (email field), `property-edit-page` and `units-section` (delete banners + the unit-name field), `manual-booking-dialog` (overlap/archived banner). Each now reads `conflictOf` and renders `describeConflict`. `booking-detail`'s cancel already handled its 409 by refetching, so it was compliant.
- **`message` is not the contract.** It stays for logs and is free to change wording without a client change; tests assert on `code`/`count`/`status`/`reasons`, never on the sentence. The old delete-guard tests that asserted `message.toContain('2')` / `not.toContain('cancel')` are rewritten to assert the structured `code` + `count`.
- **§8.2 is refined, not contradicted.** It said the slug lives in `message`; it now lives in `code`, with §8.2, §3.1, §4.4, §4.6, §5.3, §5.6 updated to match. The `{reasons:[…]}` shorthand elsewhere in the spec is unchanged - it names the same field, now under the shared shape.
- **New slugs are cheap and safe.** M3's payment 409s and M4's duplicate-connection 409 add a `conflictCodeSchema` member + a `conflict.ts` union arm + a `describeConflict` case; the compiler enforces that all three land together.
