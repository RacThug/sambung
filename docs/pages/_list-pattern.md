# Dashboard list pages - the shared pattern (teaching edition)

> **What this is:** the behaviour every `/app/*` list-type page already shares, written down once so a
> per-page spec only has to describe what **differs**. Each rule states the decision and then the
> reason, because the reason is what tells you when a page may break it.
> **What this is not:** a page inventory (that is [`../page-spec.md`](../page-spec.md) §3-§4), a route
> index ([`../sitemap.md`](../sitemap.md) §2), a visual system
> ([`../design-system.md`](../design-system.md)), or an endpoint contract
> ([`../api-spec.md`](../api-spec.md) §1).
>
> **Provenance.** Every rule below is *derived* from `apps/web/src` and the specs as they stand, not
> from general best practice. Where the shipped pages contradicted each other, the disagreement was
> recorded rather than papered over; all twelve were decided on 2026-08-02 and the reasoning is kept
> under [Divergences: resolved](#divergences-resolved-2026-08-02), because a future page needs to know
> which alternative a rule beat, not just what the rule is.

---

## 0. Which pages this covers

A **list-type page** is one whose body is a collection read from the API and acted on in place:

| Page | Reads | Body |
|---|---|---|
| `/app/calendar` | `GET /properties` · `GET /units` · `GET /bookings` | one Unit row per line, bars |
| `/app/reservations` | the same three | a table of Booking rows |
| `/app/inbox` | `GET /sync-conflicts` · `GET /payments/lapsed` | two independent queues |
| `/app/properties` | `GET /properties` | cards |
| `/app/settings` → Team | `GET /staff` · `GET /auth/invites` · `GET /properties` | roster + pending invites |
| `/app/properties/$propertyId` → Units, Channels, Photos | per-property / per-unit reads | sub-lists inside one workbench |

Two structural facts shape everything below, both from
[ADR-0010](../adr/0010-the-calendar-is-composed-not-served.md): a list page composes **neutral
primitives on the client** rather than calling a bespoke aggregate, and it therefore usually fans out
to **more than one query**. That is why "what happens when one of three reads fails" is a first-class
question here rather than an edge case.

---

## 1. Loading

### 1.1 Chrome paints first; only the body is replaced

The `<PageHeader>` (title + primary action, `components/page-header.tsx`), the filter bar, and the
source legend all render before any data arrives. Only the collection is replaced while the first read
is in flight.

*Why:* the chrome is derived from the route and the URL, not from the server, so blanking it spends a
layout shift on information already in hand. It also keeps the primary action reachable during a slow
read - an owner can open "New property" while the list is still loading.

The placeholder is a single muted block sized to the region it stands in - `h-64` for a full body
(`reservations-page.tsx`, `calendar-page.tsx`), `h-40` for an inbox queue
(`payments/lapsed-payments-section.tsx`), `h-20`/`h-16` for a card or roster (`settings-page.tsx`,
`staff/team-section.tsx`) - styled `animate-pulse rounded-lg border border-border bg-muted/40`.

### 1.2 The gate is "no data yet", not "the query says loading"

```ts
if (query.isError) return <ErrorNotice/>;
if (!query.data)   return <Skeleton/>;
```

*Why:* on a page that fans out, `isLoading` is per-query and first-load-only, while what the body needs
is "do I have enough to render". Gating on the data also survives a refetch that follows an error,
where `isLoading` is already false and `data` is still absent.

Error is checked **before** data, so a failed read never falls through to an empty state. Telling an
owner "no reservations" when the truth is "we could not ask" is the worst of the three answers, and five
lists did exactly that until D5 was fixed. `components/list-state.tsx` takes the whole query rather than
booleans so a call site cannot get the order wrong.

### 1.3 Refetch never returns to the skeleton

Two mechanisms, chosen by whether the **cache key changed**:

- **Same key** (an invalidation after a mutation): React Query keeps `data` populated while
  `isFetching`, so the rows simply stay. No page renders a refetching spinner or a dimmed state.
- **New key** (a filter or window moved, so it is a different question): the two windowed booking
  queries set `placeholderData: keepPreviousData` (`calendar/use-calendar.ts`,
  `reservations/use-reservations.ts`), so the previous month's grid or the previous filter's rows stay
  until the new answer lands.

*Why the second is explicit:* paging months or toggling a status chip is a **continuous gesture**.
Without it the grid flashes empty between clicks, which reads as "you just deleted everything" rather
than "loading". Lists whose key never changes (`["properties"]`, `["sync-conflicts"]`,
`["lapsed-payments"]`, `["staff"]`) get the same stability free from the first mechanism, which is why
they do not set it.

### 1.4 Query defaults are set once and overridden only with a reason

`lib/query.ts` sets `staleTime: 30_000, retry: 1` for every query in the app. The overrides so far:

| Override | Where | Reason |
|---|---|---|
| `staleTime: 5 min` | `settings/use-settings.ts` | the gallery cap changes about once a year, and the property workbench mounts this read on every visit |
| `retry: false` on a 404 | `bookings/booking-detail-page.tsx`, `properties/property-edit-page.tsx`, and in the funnel `public-booking/property-page.tsx`, `confirmation-page.tsx` | a 404 is an **answer**, not a blip. Retrying spends a round trip to be told the same thing and delays the message the user needs |

---

## 2. Empty state

### 2.1 An empty list is a card, and the heading says *which* empty

Presentation: a dashed-border block, centred, `p-12`, with three parts in order - a short `<h2>` naming
the state, one muted sentence, and at most one CTA.

The important half is the heading. An empty list has several distinct causes and the page distinguishes
them rather than printing one neutral "no results":

| Page | Variants |
|---|---|
| `/app/reservations` | **No upcoming reservations** (default window, empty) vs **No matches** (an explicit filter excluded everything) |
| `/app/calendar` | **Add your first property** vs **Add a unit** vs **No active units** (everything archived) |
| `/app/properties` | **Add your first property** (Owner) vs **No properties assigned** (Staff) |

*Why:* each cause has a different next action, and a generic "nothing here" hides all of them. The
Staff case is the sharpest: an empty list for a Staff member does not mean "get started", it means
"nobody has assigned you anything", and offering them a create button the server would refuse
(`@Roles('owner')` → 403, api-spec §3.6) is worse than useless.

### 2.2 Which-empty reads the URL, not the result count

`hasActiveFilters(search)` in `reservations/reservations-model.ts` asks whether the owner *touched* a
filter, not whether the result set is small.

*Why:* the two are different questions. A tenant whose only bookings are in the past has an empty
default window and no filter touched - "No matches, try widening" would be wrong, and so would "you
have no bookings". Deriving the message from the **input** rather than the output is the same
derive-don't-store grain the rest of the codebase uses (db-design §1).

A corollary: a *lone* `from` with no `to` counts as filtered even though it is not a legal window and is
never sent. The owner is mid-gesture, and the honest answer is "no matches" plus the pair hint.

### 2.3 The CTA points at the action that fixes the emptiness

`Add your first property` opens the create dialog in place; `No upcoming reservations` links to the
calendar; `No matches` offers **Clear filters**, the only control that can change the answer. A queue
that is empty because there is genuinely nothing to do carries no CTA at all
(`payments/lapsed-payments-section.tsx`, "All clear").

*Why:* a CTA in an empty state is a claim that pressing it will produce rows. If nothing the user can
press would, the button is decoration and the sentence should carry the whole message.

### 2.4 A sub-list inside a workbench uses a sentence, not a card

Units, Channels and Team render one muted line ("No units yet - add the first one above", "Nobody yet.
Invite someone above.") instead of the dashed card.

*Why:* those sections sit directly above their own add control, so the card's job - to point somewhere -
is already done by the form a few pixels below, and a `p-12` block between two dense sections costs
more than it says.

---

## 3. Errors

### 3.1 A failed read replaces the body with one sentence and leaves the page usable

```
We couldn’t load your reservations. Please try again.
```

A bordered, muted, centred block where the list would be. Chrome, filters and nav keep working, so the
user can change the question rather than reload the app.

*Why muted rather than destructive:* the design system reserves the semantic trio for status
([`../design-system.md`](../design-system.md) §2), and a transient read failure is not the same class of
event as a refusal. The copy follows the voice rule (design-system §1): say what went wrong and what to
do next.

### 3.2 A 404 is a different sentence from a failure

`bookings/booking-detail-page.tsx` branches explicitly:

```
This booking doesn’t exist, or it isn’t yours.     // 404
We couldn’t load this booking. Please try again.   // anything else
```

*Why the "or it isn't yours" clause is exactly right:* under RLS a row belonging to another Tenant, or
to a Property a Staff member is not assigned, is **indistinguishable from a nonexistent one** and
answers 404 by design (api-spec §1 "Tenancy",
[ADR-0032](../adr/0032-a-staff-scope-is-a-second-axis-in-rls.md)). The copy has to cover both without
confirming which, because confirming which is the existence oracle the 404 rule exists to prevent.

### 3.3 A 404 on a *mutation* is not an error worth showing

Dismissing a conflict or marking a payment handled swallows a 404 and shows nothing
(`channels/sync-conflicts-section.tsx`, `payments/lapsed-payments-section.tsx`), paired with
`onSettled: () => invalidate(KEY)` rather than `onSuccess` (`channels/use-sync-conflicts.ts`,
`payments/use-lapsed-payments.ts`).

*Why:* these lists are queues, and a 404 means the item is **already gone** - handled in another tab, or
resolved by the 30-minute sync between the render and the click. The user asked for it to leave the
list; it left. Refetching on settle shows the truth either way, and the alternative - an error banner on
a successful outcome - trains people to ignore errors.

The same reasoning covers a **409 on cancel** (`bookings/booking-detail-page.tsx`): the booking is
already terminal, so the dialog closes and the row refetches instead of raising.

### 3.4 403 is never rendered, because it is never reached

There is no 403 branch anywhere in `apps/web/src` - the string does not appear in the tree. Role denial
is handled by **not offering the control**: `lib/role.ts`'s `isOwner()` hides create/archive/delete and
the Team form, and Staff get one explanatory sentence in their place (`settings/settings-page.tsx`,
`properties/properties-page.tsx`, `properties/property-edit-page.tsx`).

*Why hidden rather than disabled-with-a-tooltip:* the server is the authority either way, so the
client's only job is to avoid offering a dead end. `lib/role.ts` says it in the file: read the role to
decide what to **offer**, never to decide what is **allowed**.

The second consequence is a real convention and easy to lose: on a Staff session the owner-only reads
are **never issued**, so a Staff member's session produces no stray 403s at all (page-spec §4.7).

### 3.5 A page that fans out must choose a partial-failure policy

Three shapes exist today, and they are genuinely different decisions rather than accidents:

- **All-or-nothing.** `/app/calendar` and `/app/reservations` OR their three query errors together and
  render one message. *The case for it:* the three reads compose into one artifact - a booking row
  without its Unit and Property names is not a row you can draw - so a partial render would be a
  half-truth about occupancy.
- **Per-section.** `/app/inbox` gives each queue its own loading, empty and error state. *The case for
  it:* the two queues share a page for workflow reasons only; a failed conflicts read says nothing
  about lapsed payments, and hiding both doubles one outage.
- **Degrade and retry.** The photo gallery keeps working when the `["settings"]` read fails: the gallery
  stays fully editable (removing and reordering never need the cap), only **Add photos** is blocked, and
  an inline error carries the app's one **Retry** button (`properties/photos-section.tsx`). *The case
  for it:* one missing input disables one control, and disabling it silently would read as "you may not
  add photos".

Which policy a page uses belongs in its own spec (§5 of [`_template.md`](./_template.md)). Nothing
currently decides it for a new page - see D5.

### 3.6 Mutation errors land next to the control that caused them

Never a page-level banner, never a toast. Three tiers, in this order:

| Server says | Rendered as | Mechanism |
|---|---|---|
| 400 with zod issues | under the offending input | `ApiError.fieldErrors` (`lib/api-client.ts`), `issuesToFieldErrors` for client-side parses |
| 409 | our own copy, composed from the machine-readable slug | `conflictOf(error)` → `describeConflict(body)` (`lib/conflict.ts`); the funnel has its localized twin in `public-booking/availability-copy.ts` |
| anything else | one short generic sentence beside the button | inline `<p className="text-destructive">` |

The 409 tier is a contract, not a style choice: the server sends a `code` slug plus typed detail and
**the web owns all the prose** ([ADR-0012](../adr/0012-a-409-carries-a-code-not-a-sentence.md), api-spec
§8.2). `describeConflict` is an exhaustive switch over the shared union, so a new slug that ships
without copy is a **compile error**. That is what lets a delete guard's count read as "This property has
14 bookings" instead of an un-parseable English sentence, and what makes the copy translatable.

A 409 is routed by *meaning*, not by status: a duplicate Unit name renders **on the name field** (zod
cannot catch it - it needs the other rows), while an overlap on a manual booking renders as a banner,
because it is about the world rather than about a field.

---

## 4. Pagination

**There is none, deliberately.** No list endpoint takes `limit`/`offset`/`cursor` and no page renders
pager controls (api-spec §1: "Pagination: deliberately deferred (portfolio scale)"; §9 lists it as out
of scope for v1).

What stands in its place is a **bounded window**, which is a domain filter rather than a paging
mechanism:

- `/app/calendar` shows one month, moved by `‹` / `Today` / `›`, each rewriting `?from&to`.
- `/app/reservations` opens on `[today, today + 366)` and accepts any span up to the API's 366-night
  cap; over it, `resolveWindow` refuses client-side with a hint rather than firing a request the
  boundary would 400.
- The inbox queues, the property list and the roster are read whole. They are small by construction: a
  queue that grows is a problem to fix in the world, not a list to page through.

*Why a window beats a page number here:* the underlying question is already temporal ("who is in this
month"), so the window **is** the filter, and it is shareable and reproducible in a way `?page=3` never
is. The cost is stated honestly in api-spec §1: revisit if a list outgrows one screen.

Where a count matters it is a footer, not a pager: `N reservations` under the table. That is currently
the only signal that could ever trigger the revisit (D12).

---

## 5. Filters and sort

### 5.1 Everything that changes the question lives in the URL

`?from&to&propertyId` on the calendar (`calendar/calendar-search.ts`);
`?from&to&propertyId&status&source` on reservations (`reservations/reservations-search.ts`). A filtered
view is a link an owner can paste to a colleague and get the same screen.

Each page's search params are a **zod schema validated at the route** (`validateSearch` in
`router.tsx`), because a pasted URL is external input, held to the same rule as an HTTP body
([`../architecture.md`](../architecture.md) §4, api-spec §1). Every field ends `.catch(undefined)`, so
`?from=oops` opens the default view rather than crashing the dashboard home.

### 5.2 What does *not* go in the URL

- **Defaults.** An absent `from`/`to` resolves at render (current month, or the upcoming window). The
  URL stays bare until the user chooses, so a shared link means "the current month" rather than freezing
  the month it was copied in.
- **Ephemeral UI state.** Which dialog is open, which unit row is being edited, which photo is
  uploading. These are `useState`, per architecture §4.3: only server state belongs in the query cache,
  only shareable state in the URL.
- **Sort.** There is no sort control. The server sorts by check-in and the client never re-sorts
  (`reservations/reservations-model.ts` says so at the join). *Why:* one definition of order. A
  client-side sort is a second opinion that would drift from the CSV export, which shares the server's
  filter builder.

### 5.3 Set filters are repeatable, canonically ordered, and drop out when empty

`status` and `source` are multi-valued. `toggleValue` (`reservations/reservation-filters.tsx`) rewrites
the set in a fixed canonical order and returns `undefined` when it empties, so the param leaves the URL.

*Why the canonical order matters:* `?status=a&b` and `?status=b&a` are the same filter. Without
canonicalisation they are two URLs, two cache keys, and two fetches of one answer. The URL is the cache
key's source, so stabilising one stabilises the other.

URL form and wire form differ on purpose: the browser URL carries the router's array encoding, while
`bookingsQueryString` emits **repeated keys** (`?status=a&status=b`) for the API's `repeatable()`
preprocessor (`packages/shared/src/booking-list.ts`). One builder emits it, shared by the table and the
CSV export, so "the export respects the active filters" holds by construction.

### 5.4 Cross-field validation happens once, on the client, before the request

`resolveWindow` returns a window that is **always a legal pair**, plus an `error` hint and an `isDefault`
flag. A lone edge or a reversed range never becomes a request.

*Why:* the API 400s a lone edge, and a 400 the client could have predicted is a round trip spent to
learn something already known. This is the exclusion-constraint discipline pointed at the UI: check it
here for the user's sake, and let the boundary stay the authority (invariant #5).

The cost is a duplicated rule - the same pair/order/366-night checks live in
`packages/shared/src/booking-list.ts` (`listBookingsQuerySchema`) and in `reservations-model.ts`. A page
spec should record that under §7 of [`_template.md`](./_template.md) with `leak: true`.

---

## 6. Mutations and feedback

### 6.1 Feedback is inline and local, and there are no toasts

Every mutation reports beside the control that started it:

- **Pending**: the button's own label changes (`Saving…`, `Working…`, `Syncing…`) and the button
  disables. Per-row mutations are per-row hooks, so one row's spinner does not spin every row's button.
- **Success**: a quiet word or one-line summary next to the button (`Saved`, `Invite emailed to …`,
  `Disconnected. 3 imported bookings kept.`, `2 feeds checked · 1 imported`). `calendar/sync-now-button.tsx`
  wraps its line in `role="status" aria-live="polite"`, so a screen-reader user learns the outcome
  without being interrupted.
- **Failure**: §3.6.

*Why a summary beside the button rather than a toast:* `sync-now-button.tsx` argues it in place - a sync
result is something an owner may want to read twice ("1 clashed" sends them to the Inbox), and a toast
takes it away on a timer. This diverges from page-spec §2, which mandates toasts for 5xx/network; see
D7.

### 6.2 After a mutation, refetch the server's answer - never patch the list locally

Both inbox queues invalidate their key and re-read rather than splicing the acted-on row out of the
array. Both hook files give the same reason: a client-side removal is a **second opinion** about what is
open.

*Why this is more than tidiness:* the queue's membership is a server-side predicate (a lapsed payment
leaves the inbox because `handled_at IS NULL` stops matching, not because anything about the ledger
changed - [ADR-0022](../adr/0022-the-paid-but-lapsed-inbox-marks-not-mutates.md)). Re-asking is the only
way the list and the predicate cannot disagree.

The exception is the **whole-set PATCH**, where the response *is* the fresh row: `settings/use-settings.ts`
and `properties/photos-section.tsx` call `setQueryData(KEY, updated)` and skip the refetch. That is not a
local patch - it is the server's own answer, painted rather than re-requested.

### 6.3 Invalidate by what actually moved, at the widest key that is true

- A new priced Unit invalidates `["properties"]` (the prefix), because it flips the Property's
  `publishable` and the banner must move in the same paint.
- A manual booking invalidates `["bookings"]` (the prefix), so the calendar and every reservations
  filter combination re-read.
- A per-feed sync invalidates the connection list **plus** `["bookings"]` **plus** `["sync-conflicts"]` -
  the three things one pull can change.
- Revoking an invite invalidates `["invites"]` only. It has no business refetching the roster.

*Why the prefix rule cuts both ways:* too narrow leaves a stale badge on screen, too wide refetches work
nobody asked for. The test is causal, not convenient: what could this write have changed?

### 6.4 Destructive actions confirm; reversible ones do not

Delete a Unit, delete a Property, remove a Staff seat, disconnect a Channel: all confirm first. Archive
and unarchive do not.

*Why the line falls there:* archive is reversible and keeps every booking
([ADR-0005](../adr/0005-archived-is-derived-not-cascaded.md)), so a mis-click costs one more click.
Delete is only ever offered on inventory nothing was booked on, and the copy says the reason up front
rather than only on failure ([ADR-0002](../adr/0002-deleting-inventory-never-destroys-the-ledger.md)).

The confirm text names the thing and the consequence, not "Are you sure?": *Disconnect Airbnb from
"Garden Room 1"? Imported bookings are kept.*

### 6.5 A shared cache key is how two surfaces stay in agreement

The Inbox nav badge calls the **same two hooks** the inbox page's sections call
(`dashboard/use-inbox-count.ts`), so badge and page read one cache entry each and cannot disagree. The
photo gallery reads the cap from the same `["settings"]` key the settings page writes, so raising the cap
unblocks **Add photos** without a reload.

*Why this is the pattern and not a coincidence:* it is the read-can't-disagree-with-write rule this
codebase applies everywhere, expressed in the query cache. Two components asking one question must ask
it once.

A badge is best-effort by contrast: an error or a cold cache reads as `0`, because a nav badge must never
block navigation.

---

## 7. Skeletons and the two-surface doctrine

[ADR-0007](../adr/0007-two-surface-design-system.md) splits the app into a rethemed-shadcn dashboard and
a hand-designed public funnel, and the skeletons follow that split rather than sharing one component:

- **Dashboard**: one **grey block sized to the region** it replaces. It does not mimic the table's
  columns or the calendar's rows.
- **Public funnel** (`public-booking/property-page.tsx`, `PropertySkeleton`): a **shaped** placeholder -
  a hero rectangle, a title bar at `w-2/3`, a subtitle at `w-1/3`, two unit cards - mirroring the real
  layout.

*Why the asymmetry is correct rather than lazy:* the funnel's skeleton is part of a stranger's first
impression and its job is to promise the page that is coming, so it is worth hand-shaping. The
dashboard's job is to occupy the space without shifting layout for someone who already knows what is
there. Owners are not judging the loading state; they are waiting for their calendar.

Two constraints hold on both surfaces:

- **Semantic tokens only** (`bg-muted/40`, `border-border`). A raw `stone-*`/`terra-*` utility in a
  feature file is a review flag (design-system §6).
- **No `Skeleton` primitive exists in `components/ui/`** (which holds button, dialog, input, label,
  sonner). The doctrine is copy-in-per-need, never the whole catalog (design-system §4), and a one-line
  `animate-pulse` div has not yet earned a component. A third variant is the moment to reconsider, not
  before.

---

## 8. How a page spec uses this file

A page spec written from [`_template.md`](./_template.md) should describe:

1. Its purpose, entry/exit, and URL state (§1-§2 of the template).
2. Its data requirements, requests, interactions, and business rules (§3-§4, §6-§7).
3. **In §5 (States), only the deltas from this document** - its empty-state variants and copy, its
   partial-failure policy (§3.5 above), anything it does differently and why.

If a page follows every rule here, its States section says so and stops. If it breaks one, the break
belongs in its spec with a reason; if the reason generalises, it belongs here instead, in its own PR.

---

## Divergences: resolved 2026-08-02

All twelve were decided in one pass, because they were one question asked twelve ways: *when the pages
disagree, which one is right?* Six were defects and were fixed; six were preferences and are now written
down as rules. The section is kept rather than deleted - the reasoning is the useful part, and a future
page needs to know not just what the rule is but which alternative it beat.

### Fixed

**D1. Loading is a shaped block and never eats the page header.**
`/app/properties`, the workbench, Units and Channels returned a line of text *before* `<PageHeader>`, so
the title and primary action vanished on load and popped back in. Now every list uses `ListSkeleton` and
the chrome always paints (§1.1). One test changed as a result, and how it changed is the proof: the shell
test asserted the "New property" button synchronously after finding the heading, which only worked while
the page withheld its own header.

**D2. The gate is `!data`, never `isLoading`.**
`isLoading` goes false the instant a *failed* attempt settles, which is exactly how D5 happened. Error is
checked first, then data (§1.2).

**D3. A queue always renders its heading, and says "no conflicts" out loud.**
The sync-conflicts section returned `null` for loading, empty and error alike - on the page whose whole
job is surfacing what needs attention, directly above a sibling that rendered all three. It now matches
the sibling. page-spec §4.6's specified empty copy exists at last.

**D5. Every list has an error branch.**
Five had none: properties, Units, Channels, the Team roster and pending invites, and sync conflicts. A
failed read fell through to the *empty* state, so `/app/properties` told an owner whose network blipped
to "add your first property". This was the worst thing in the audit - not because it is hard to fix, but
because the list actively lied. The workbench also stopped answering "Property not found." to every
failure and now distinguishes a real 404 (§3.2).

**D6. The router has an error boundary and a 404 route.**
page-spec §2 promised both; `router.tsx` set neither, so a render-time throw reached a blank screen and
`/app/typo` matched nothing. `defaultErrorComponent` (with a `reset` retry) and
`defaultNotFoundComponent` now exist. They are the last resort *behind* every per-page state here: a page
that handles its own failed read should never reach them.

**D9. Search params are patched, never replaced.**
The calendar wrote a whole new search object, so every handler had to re-thread `propertyId` by hand. It
worked; a fourth control would have cleared the property filter as a side effect of paging a month. Now
`search: (prev) => ({ ...prev, ...next })` everywhere, with "Today" clearing the window explicitly
because that is what it means.

### Decided, no code change

**D4. A page-level list gets the dashed card; a sub-list inside a workbench card gets one muted line.**
The card's job is to point somewhere, and a sub-list already sits above its own add control (§2.4).

**D7. Inline feedback is the convention. The toast rule is retired, and `sonner` is removed.**
It was mounted in `main.tsx`, listed in design-system §5, mandated by page-spec §2 - and **never
called**. Two ways out: start using it, or admit the app does not want it. `sync-now-button.tsx` already
argued the case in place - a sync summary is something an owner may want to read twice, and a toast takes
it away on a timer - and every error now has a place to go (D5, D6). A mounted host nothing calls is the
dead-weight this repo dislikes elsewhere, so it went.

**D8. A failed READ is muted; a refused ACTION is destructive.**
The semantic trio is for status (design-system §2), and "we could not ask" is not the same class of event
as "no". Settings was the lone dissenter and now matches.

**D10. Destructive confirms should use the `Dialog`, not `window.confirm`.**
Four sites still use `window.confirm` (delete Unit, delete Property, remove Staff, disconnect Channel);
only booking-cancel uses the styled path. `window.confirm` cannot carry the explanation the voice rule
asks for and is the one modal off the headless-primitive path ADR-0007 mandates. **Recorded as the rule;
the four migrations are follow-up work** - it is UI surgery on destructive paths, and bundling it into a
change this size would be the wrong risk.

**D11. `onSettled` for an idempotent guarded verb, `onSuccess` otherwise.**
The inbox mutations invalidate on settle because a 404 means the item is already gone (§3.3). That
reasoning generalises only to verbs that are idempotent *and* guarded server-side; archive/unarchive
qualify and may adopt it, and nothing else should.

**D12. The row count stays on reservations alone.**
It is the only list where "how many" is the question being asked. api-spec §1's "revisit if any list
outgrows one screen" keeps its one signal.
