# Migration report - `page-spec.md` → `docs/pages/`

> Produced after migrating [`../page-spec.md`](../page-spec.md) into per-page specs at commit
> **6702881**. Counts below were computed from the written files, not estimated.
>
> `page-spec.md` itself was left untouched apart from its `status: legacy` frontmatter and the
> one-line pointer at the top.

---

## 0. Status since publication

This report is a point-in-time record and is not rewritten as findings are closed. What has changed:

**One number in it was wrong.** §2 says "26 Open questions across the 13 files". The count was **43**
(`grep -c '^- \[ \]'`, excluding `_template.md`'s specimen). It now stands at **42 open, 5 closed**
across **14** specs.

**Closed by the first remediation pass:**

| Finding | Was | Now |
|---|---|---|
| `/app` shell had no page spec | §1, §6c | [`app-shell.md`](./app-shell.md) written; `switchTenantRequestSchema` and `userRoleSchema` left the allowlist |
| `bookable` inlined instead of shared `isSellable` | §3.E | `p-slug.md` calls the shared helper; no longer a leak |
| Half-open → inclusive written twice in the funnel | §3.B | `lastNightOf` added to `packages/shared` beside `countNights`, 5 tests; both sites call it; no longer a leak |
| Refusal precedence implemented twice | §3.G | ordering moved to `lib/refusal.ts`; still FE, still one leak, no longer duplicated |
| Web validated a Unit edit with the create schema | §6c | edit row parses with `updateUnitRequestSchema`; entry left the allowlist |
| Login collapsed `403` into the generic error | (not in this report; `login.md` §10) | `auth.noWorkspace` in all three catalogs |
| `api-spec.md` drift: stale Status column, missing `POST /channels/sync`, `depositPct`, `propertyId` | phase-0 audit §4.2 | corrected; `#17` recorded as **Dropped**; `sitemap.md`'s dangling "api #201" now `api #40` |

**Closed by the second pass** (Docker up, so `apps/api` became verifiable):

| Finding | Was | Now |
|---|---|---|
| Effective-archived derived in the browser, 9 rules over 3 files | §3.A | `UnitResponse.archived`, derived by the join every Unit read already performed. api-spec §4.6 **amended** (it had mandated the client-side derivation) with the old wording quoted. 3 API tests, one proven red against the pre-change SQL. No migration. |
| Balance at the property subtracted in the browser | §3.C | `balanceIdr` on `bookingConfirmationResponseSchema`, clamped at zero so an overpayment cannot render as a credit. `booking-bookingId.md` now has **no leaks**. |
| `meResponseSchema` "has no non-test caller anywhere" | §6c | **Overstated, corrected.** The *type* `MeResponse` is used by `auth.controller.ts` and `auth.service.ts`; it is the zod schema that has no runtime caller, the response being framed by type rather than parse. The endpoint is kept deliberately - api-spec §3.5 specifies a behaviour that differs from `refresh` on purpose. |

**Counts after both passes:** **23 leak rows** (was 30), **11** schemas + **1** route in the allowlist
(was 14 + 2), 266 data rows across 14 specs, 653 API tests (was 650).

**Not done, and why:**

- **§3.H the inbox count** - reclassified rather than built. The badge sums two lists it already holds,
  sharing the inbox page's own cache entries so the two cannot disagree (`_list-pattern.md` §6.5). A
  server count would ADD a third request per dashboard page and break that property. The right answer is
  "accepted", which is a decision for the owner, not a change to make.
- **§3.C the checkout deposit split** - the two inputs come from two different reads (`depositPct` from
  the property, the total from the quote), so there is no single response that could state it. The only
  lossy step, the floor, already runs through shared `depositAmountIdr`, which is pinned to the API's
  BigInt twin by a test.
- **§4 the workbench's N+3 reads** - a batched `GET /properties/:id/channels` is a new endpoint, which is
  scope beyond a remediation pass.
- **Everything under E** in the triage list: they are product decisions, not defects.

---

## 1. What was migrated

**13 page specs** from page-spec §3.1-§3.4 and §4.1-§4.7.

**Two routes in the router have no page-spec source and therefore no file:**

| Route | Why |
|---|---|
| `/` | page-spec §6 lists a marketing/landing site as **out of scope** and says "root redirects to login". The route renders `LandingPage`. There is nothing to migrate, and the spec actively contradicts the code. |
| `/app` (the shell) | page-spec §2 describes it as cross-cutting behaviour ("Shared shell, applies to every page"), not a page. Its auth guard is captured in `login.md` §2; its sidebar, account menu, workspace switcher and inbox badge are captured nowhere. |

The second gap has a measurable consequence - see §6.

---

## 2. Rows by Source tag, per page

| Page | Data rows | `[spec]` | `[code]` | `[TBD]` |
|---|---|---|---|---|
| `p-slug.md` | 29 | 0 | 29 | 0 |
| `p-slug-book.md` | 18 | 0 | 18 | 0 |
| `booking-bookingId.md` | 11 | 0 | 11 | 0 |
| `login.md` | 10 | 0 | 10 | 0 |
| `register.md` | 12 | 0 | 12 | 0 |
| `invite-token.md` | 11 | 0 | 11 | 0 |
| `app-calendar.md` | 23 | 0 | 23 | 0 |
| `app-reservations.md` | 20 | 0 | 20 | 0 |
| `app-bookings-bookingId.md` | 16 | 0 | 16 | 0 |
| `app-properties.md` | 12 | 0 | 12 | 0 |
| `app-properties-propertyId.md` | 44 | 0 | 44 | 0 |
| `app-inbox.md` | 22 | 0 | 22 | 0 |
| `app-settings.md` | 20 | 0 | 20 | 0 |
| **Total** | **248** | **0** | **248** | **0** |

**Why there are no `[spec]` rows, and why that is a finding rather than a formality.** A `[spec]` tag
means "carried from page-spec, inherited rather than checked". Every field page-spec names turned out to
be renderable from a file that could be read, so each was re-derived and tagged `[code]`. The tag
survives in the template because the *next* migration - of a page not yet built - will have nothing else
to cite.

**Why there are no `[TBD]` rows.** `[TBD]` is for a value that cannot be determined from the original or
the code. No data row hit that: every rendered value traced to a schema, an endpoint, or a client
computation. What *is* undetermined is captured elsewhere - **26 Open questions across the 13 files** -
because those are decisions about what *should* happen, not gaps in what does.

**Where page-spec and the code disagreed**, the code was recorded and the disagreement filed as an Open
question. Five such cases:

| Page | page-spec says | Code does |
|---|---|---|
| `p-slug-book.md` | body is `{ guestName, guestContact }` | `{unitId, checkIn, checkOut, guestName, guestPhone, guestEmail?, guestCount}` (migration 0007 split it) |
| `booking-bookingId.md` | a "retry payment" action | no such control |
| `app-calendar.md` | a bar opens a "detail drawer"; Data is api #18 | opens a page; three reads |
| `app-bookings-bookingId.md` | a conflict banner from an api #32 lookup | not built - the inbox links the other way |
| `app-properties-propertyId.md` | no mention of `timeZone`, `depositPct`, Archive zone, public-link control | all four shipped |

---

## 3. Every `leak: true` rule, consolidated

**30 rules** across 10 pages. Three pages have none: `login.md`, `register.md`, `invite-token.md` - all
three are forms over one endpoint, which is what a page with no business logic in it looks like.

### A. Effective-archived and its consequences - 9 rules, 3 pages

The single largest cluster, and the only one the API contract **mandates**: api-spec §4.6 specifies that
effective-archived is derived client-side, because `GET /units` and `GET /properties` each carry only
their own `archivedAt`.

| Page | Rule |
|---|---|
| `app-calendar.md` | effective-archived = the Unit's flag OR its Property's |
| `app-calendar.md` | an archived-and-empty Unit is dropped from the grid |
| `app-calendar.md` | an archived Unit's day cells do not invite a create |
| `app-properties-propertyId.md` | effective-archived (second derivation site) |
| `app-properties-propertyId.md` | an archived Property makes its Units section read-only |
| `app-properties-propertyId.md` | an archived Unit hides its edit affordance |
| `app-properties-propertyId.md` | a retired Property's URL is offline but reserved |
| `app-properties.md` | archived beats `publishable` in the status line |
| `app-properties.md` | archived = `archivedAt` is set |

**Closing all nine costs one field and no migration**: a derived `archived: boolean` on
`unitResponseSchema`, computed in `apps/api` from the join it already performs. Both columns exist.

### B. Half-open date arithmetic - 4 rules, 3 pages

| Page | Rule |
|---|---|
| `p-slug.md` | a blocked `[from, to)` displays as nights `from … to-1` |
| `p-slug.md` | a selection is a stay only when `to > from` |
| `app-calendar.md` | a stay clips to the window; `end <= start` drops it |
| `app-reservations.md` | a window must be a pair, `from < to`, at most 366 nights |

Each re-encodes db-design §4.2 in the browser. The last is a deliberate UX mirror of
`listBookingsQuerySchema`; the first appears **twice more** inside the funnel
(`availability-model.ts` and `availability-copy.ts` both compute `addDays(to, -1)`).

### C. Money arithmetic - 4 rules, 2 pages

| Page | Rule |
|---|---|
| `p-slug-book.md` | a deposit is "partial" only when `depositPct < 100` |
| `p-slug-book.md` | balance at the property = `total − deposit` |
| `booking-bookingId.md` | balance at the property = `totalPriceIdr − amountPaidIdr` |
| `booking-bookingId.md` | show the balance line only when `totalPriceIdr > amountPaidIdr` |

Money arithmetic in the client, on the two pages a guest reads before and after paying. The checkout
case is the sharper one: the server already returns `amountIdr` and `deposit` on
`paymentSessionResponseSchema`, and the page **fetches that response and does not read those fields**.

### D. Hold expiry on the client clock - 2 rules, 2 pages

| Page | Rule |
|---|---|
| `p-slug-book.md` | the Hold has lapsed when the client clock passes `holdExpiresAt` |
| `app-bookings-bookingId.md` | remaining hold minutes |

The first is the most consequential leak in the report: a countdown reaching zero moves checkout to a
terminal state with no server confirmation, so a skewed clock ends a live Hold early.

### E. Eligibility - 5 rules, 4 pages

| Page | Rule |
|---|---|
| `p-slug.md` | a Unit is bookable iff its nightly rate is above zero |
| `app-bookings-bookingId.md` | Cancel is offered only for an Occupying booking |
| `app-properties-propertyId.md` | the gallery is full at `length >= cap` |
| `app-properties-propertyId.md` | one connection per (Unit, Channel) - options disabled |
| `app-settings.md` | a staff member must hold at least one Property |

Four of the five are honest UX mirrors of a server rule that also refuses. The first is not: shared
`isSellable` exists and does exactly this, and the dashboard calls it - only the public page inlines it.

### F. Identity and labels - 2 rules, 2 pages

| Page | Rule |
|---|---|
| `app-reservations.md` | a booking title is the guest, or "Manual block", or "Walk-in" |
| `app-bookings-bookingId.md` | the same rule, via the same shared helper |

One rule, one helper (`booking-display.ts`), two consumers. It encodes CONTEXT.md's Walk-in definition as
a display fallback - a domain word chosen in the client.

### G. Copy precedence - 1 rule, 1 page

`p-slug-book.md`: refusal reasons are **ranked**, not listed - dead unit > overlap > capacity >
min-stay. The identical four-branch ordering exists twice in `apps/web` (`availability-copy.ts` for the
localized funnel, `lib/conflict.ts` for the English dashboard).

### H. Definitions with no server counterpart - 3 rules, 3 pages

| Page | Rule |
|---|---|
| `app-reservations.md` | the default view is `[today, today + 366)` |
| `app-inbox.md` | the inbox count is open conflicts **plus** lapsed payments |
| `app-properties-propertyId.md` | the live Verified preview, recomputed from the unsaved licence input |

Nothing on the server answers any of these three questions. The inbox count is the one to watch: add a
third queue and the badge is where it will be forgotten.

---

## 4. Pages with more than 3 blocking requests

**One.**

| Page | Blocking reads | Detail |
|---|---|---|
| **`app-settings.md`** | **4** (Owner) | `GET /settings`, `GET /staff`, `GET /auth/invites`, `GET /properties`. Each blocks only its own card or list, and a Staff session issues exactly one of them. |

At the threshold but not over it:

| Page | Blocking reads |
|---|---|
| `app-calendar.md` | 3 (`/properties`, `/units`, `/bookings`) |
| `app-reservations.md` | 3 (the same three) |
| `app-inbox.md` | 2, neither blocking the page - each blocks its own section |
| `p-slug.md`, `booking-bookingId.md`, `login.md`, `register.md`, `invite-token.md`, `app-bookings-bookingId.md`, `app-properties.md`, `app-properties-propertyId.md` | 1 |
| `p-slug-book.md` | **0** - both reads are advisory; the page's gate is the URL |

**A separate measure worth recording, because the blocking count hides it:**
`app-properties-propertyId.md` has one *blocking* read but the highest *total* request count in the app -
`1 + 1 + 1 + N` on mount, so a Property with 8 Units issues **11 reads**, one per Unit for its channel
connections. There is no batched `GET /properties/:id/channels`.

---

## 5. UI elements with no supporting field

**55 rows carry `Schema: none`.** Two thirds are chrome, which is expected and not a defect. The split
matters, so both are listed.

### 5a. Chrome - no field is expected (43 rows)

Page titles, wordmarks, section headings and lead paragraphs (13); buttons and links whose label is
static (12); loading, empty and error copy (9); form affordances and validation hints rendered from a
schema rather than a value (9).

Named in full: page title ×6, wordmark/subtitle ×3, back link ×2, section heading + explanation ×3,
Team section lead, "New property", "Export CSV", "Check availability"/"Close", Book CTA, Dismiss,
"Mark handled", "Change access / Remove / Revoke", "Clear filters", prev/Today/next, submit button label
×2, owner empty copy + CTA, staff empty copy, "no rooms yet", "add a property first", "showing upcoming"
caption, window error hint, "Hold (unpaid)" hatch, spinner + copy, per-file progress, time-zone labels,
"Saved"/error line ×2, submit error line ×2, generic submit error, error line (non-404) ×2, Cancel error
line, "payment couldn't start", 401 wrong-password copy, settings-failed line + Retry, "invite emailed to
X", image `alt` text, country selector, CSV file.

### 5b. A rendered **value** with no field behind it (12 rows)

These are the ones worth reading. Each is a number, a URL or a state the user acts on, derived rather
than carried.

| Page | Element | What it is derived from |
|---|---|---|
| `p-slug.md` | `og:url` | `window.location`, deliberately not on the wire (`og.ts` says the canonical URL is caller-context) |
| `p-slug.md` | past days disabled | the browser's own local today (ADR-0013) |
| `p-slug-book.md` | "balance at the property" | `total − deposit`, computed in the browser |
| `booking-bookingId.md` | "balance at the property" | `totalPriceIdr − amountPaidIdr`, likewise |
| `app-reservations.md` | "N reservations" | `rows.length` - the app's only list-size feedback |
| `app-inbox.md` | sidebar count badge | the two queue lengths summed |
| `app-calendar.md` | *(bar geometry, colour, hatching, labels - carried as fields but computed FE)* | see §3.A/B |

Five of the twelve are the same two leaks (balance arithmetic, inbox count) seen from the data table
rather than the rules table. Two - `og:url` and the past-date guard - are correctly client-side and are
recorded as **not** leaks in their page specs.

---

## 6. Shared exports not referenced by any page spec

`packages/shared` exports **177** names. **96** are unreferenced by any page spec, which splits three
ways.

### 6a. Naming artifact - the schema *is* cited, its inferred type is not (58)

`BookingRow`, `AuthResponse`, `PublicUnit`, `UnitResponse`, `PropertyResponse` and 53 more. The template
requires the **schema** export name (`bookingRowSchema`), because that is the thing `tsc` checks against
a parse. Their `z.infer` twins are cited nowhere by design. **No action.**

### 6b. Server-side or embedded - unreferenced because no page can reference them (35)

| Group | Exports |
|---|---|
| Embedded in a cited schema | `importIcalUrlSchema`, `inviteTokenSchema`, `rupiahSchema`/`Rupiah`, `bookingRefusalReasonSchema`, `presignPhotoRequestSchema`, `syncConflictStatusSchema`, `userRoleSchema` |
| Pure helpers `apps/api` calls | `quoteTotalIdr`, `meetsMinStay`, `toRupiah`, `normalizeWaPhone`, `parseConflictBody` |
| Slug minting (server-only) | `SLUG_PATTERN`, `slugifyName`, `slugCandidates` |
| Machine routes with no page | `healthResponseSchema`, `noBodyRequestSchema` |
| Constants behind a rule | `MAX_NIGHTLY_RATE_IDR`, `PHOTO_GALLERY_CEILING`, `PHOTO_EXTENSIONS`, `DEFAULT_GALLERY_CAP`, `DEFAULT_DEPOSIT_PCT`, `OccupyingStatus` |
| API-side response framing | `createOwnerBookingResponseSchema`, `paymentProviderSchema` |

`PHOTO_GALLERY_CEILING` does reach a page, as `galleryCeiling` on the settings response - which is
exactly why `settings.ts` echoes it rather than letting the SPA pin its own copy.

### 6c. Genuine gaps (3)

| Export | Finding |
|---|---|
| **`switchTenantRequestSchema`** | `POST /auth/session` and the whole workspace switcher live in the **`/app` shell, which has no page spec** (§1). The web posts `{tenantId}` raw without parsing it; only `apps/api` uses the schema. This is the single clearest cost of the missing shell spec. |
| **`meResponseSchema`** | **No non-test caller anywhere** - not in `apps/web`, not in `apps/api`. `GET /auth/me` exists and has no FE consumer (confirmed independently by `sitemap.md` §4), and its response is not framed through the schema either. A dead export on a dead endpoint. |
| **`updateUnitRequestSchema`** | `apps/api` validates `PATCH /units/:id` with it, but the web parses **both** the add row and the edit row with `createUnitRequestSchema`. The client never uses the partial schema, so an edit is validated client-side against the stricter create rules. Not a bug today - `createUnitRequestSchema` supplies defaults for the two optional fields - but the two sides validate the same request differently. |

---

## 7. Suggested order of resolution

Derived from the counts above, not from taste.

1. **The effective-archived contract** (§3.A). Nine leaks, one field, no migration. Nothing else in the
   report has that ratio.
2. **The client-clock Hold expiry** (§3.D). One rule, but it is the only leak that can end a live
   checkout for a paying guest.
3. **The `/app` shell spec** (§1, §6c). Its absence is measurable: an endpoint, a schema and four shell
   surfaces documented nowhere.
4. **The money arithmetic on the two guest-facing pages** (§3.C). The server already sends the answers
   the checkout page recomputes.
5. **`meResponseSchema` and `GET /auth/me`** (§6c). Delete, or wire the SPA's session restore through it.
