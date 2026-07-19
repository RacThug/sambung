# ADR-0016: The .ics export feed is addressed - and authenticated - by its unit UUID

- **Date**: 2026-07-19
- **Status**: Accepted
- **Issue**: #55 (M4, channel-sync export side)
- **Builds on**: ADR-0003 (a Visitor is a principal), ADR-0008 (a public resolver resolves, it does not judge), ADR-0005/0006 (archive)

## Context

M4 gives an owner a public `.ics` URL to paste into an OTA's "import calendar"
box, so Airbnb/Booking.com/Vrbo stop selling nights already booked on Sambung
(FR-SYNC-2, api-spec §7.6). The feed is fetched by the OTA's calendar subscriber,
which has **no Sambung token** and no way to send one - you cannot type a Bearer
header into Airbnb's import field. So the endpoint is unauthenticated.

That collides with two invariants. Invariant #2: every tenant-owned query is
scoped by `tenant_id`, and a no-auth read must not become a cross-tenant hole.
And the AC: the feed exposes only confirmed occupying bookings, as all-day events,
and **never** a guest name, email, phone, or price - this URL is pasted into a
third party's system.

The decision is: how is an unauthenticated fetch scoped to exactly one unit's
calendar, and what is the access control?

## Decision

**The unguessable unit UUID in the path is BOTH the address and the capability.**
`GET /public/units/:id/calendar.ics` resolves the tenant from the unit id via the
existing pure resolver `PublicScope.enterFromUnitId` (ADR-0008), mints a Visitor
principal, and reads that unit's confirmed bookings **under RLS**. There is no new
auth mechanism: holding the UUID is the capability, exactly as api-spec §7.6
specifies ("Unguessable unit UUID is the v1 access control").

Three properties fall out of reusing the resolver:

1. **Structurally not a cross-tenant read path.** Everything after
   `enterFromUnitId` runs under RLS as the resolved tenant. A bug in the booking
   query cannot reach another tenant's rows - the database filters them. The
   feed's tenant-safety is the *same* mechanism as the availability quote and the
   pay step, not a bespoke check that could be wrong.

2. **Archive-blind, on purpose.** The resolver judges nothing (ADR-0008), and the
   export service adds **no** archived check. An archived Unit that still has
   bookings MUST keep serving its calendar: an OTA that already subscribed would
   otherwise see those nights as free and double-book. Retiring a Unit hides it
   from *guests* (its public page 404s, its quote 404s - ADR-0006); it does not
   un-tell an OTA about stays that exist. This is the third distinct downstream
   judgement over the one pure resolver: read → 404 (ADR-0008), booking write →
   409 (ADR-0011), export → no judgement at all.

3. **PII cannot leak, by construction.** The export reads only
   `(id, check_in, check_out)` for `status = 'confirmed'` bookings, and the
   serializer's input type (`CalendarEvent`) has *no field* for a name, email,
   phone, or price. The `SUMMARY` is a fixed constant. So there is no code path
   that puts guest data into the `.ics` - it is unrepresentable, not merely
   omitted. `UID` is the booking id (an opaque UUID), which identifies the block
   for the OTA's dedup and carries nothing sensitive.

**Half-open dates map to iCal natively.** A stay is `[check_in, check_out)`
(invariant #4). An all-day `DTEND;VALUE=DATE` is *also* exclusive - it names the
day after the last occupied night. So `DTSTART = check_in`, `DTEND = check_out`,
with zero arithmetic, and an OTA reading the feed frees the checkout night exactly
as Sambung does.

## Alternatives considered

- **A per-feed secret token column** (`channel_connection.export_token` or a
  per-unit token). Rejected for v1: it adds a column and a rotation story for a
  marginal gain over a 122-bit unguessable UUID, and §7.6 explicitly defers it to
  "if the repo goes public-demo". Recorded as the hardening path.
- **The owner (DbService) connection with a manual `WHERE unit_id`.** Rejected: it
  would make the feed the *one* no-auth reader that bypasses RLS, so its
  tenant-safety would rest entirely on remembering a WHERE clause - the precise
  failure mode invariant #2 and the RLS layer exist to make impossible. The
  Visitor-under-RLS path has the WHERE *and* RLS, like every other reader.
- **The `ics` npm library.** Rejected: an all-day VEVENT is trivial RFC-5545, and
  a hand-rolled ~80-line builder keeps the no-PII guarantee as a *type* (the input
  has no PII field) and avoids a dependency (guardrail: flag heavy deps).

## Consequences

- The feed is world-readable to anyone holding the unit UUID - acceptable for v1
  (the UUID is unguessable and the payload is availability only), upgradeable to a
  per-feed token without changing the addressing model.
- The smoke fetch on **connect** (§7.1) is an outbound request the server makes on
  the owner's behalf → an SSRF surface. Mitigated: it only ever leaks a boolean
  (reachable + looks-like-a-calendar, never the body), it is owner-authenticated,
  and the real fetcher refuses private/loopback host literals **on every redirect
  hop, not just the initial URL** - it follows redirects manually (`redirect:
  'manual'` + a hop cap) and re-validates each `Location`, because
  `redirect: 'follow'` would let a public host `302` into an internal address (the
  metadata endpoint, the Postgres/Garage host) that the pool would silently follow.
  What is still *not* covered: a hostname that resolves to a private IP (DNS
  rebinding). Connect-time IP checks + a full egress allowlist + a per-connection
  feed token are the documented hardening path, out of scope for v1.
- A future column on `booking` (say a payout reference) cannot leak through the
  feed: the export selects three columns by name, and the serializer has nowhere
  to put a fourth.
