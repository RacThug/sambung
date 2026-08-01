---
route: /app/example/$exampleId
status: draft            # draft | agreed | in-build | shipped
prd_section: "§5 FR-XXXX-1"
adrs: []                 # decisions this page is bound by, e.g. [ADR-0007, ADR-0010]
verified: false          # has every [code] row been re-read against the tree at this commit?
---

# `<Page name>` - `<route>`

> **How to use this file:** copy it to `docs/pages/<route-slug>.md`, fill it in **before** building, and
> delete each *italic guidance line* as you answer it. A section with nothing in it says "considered,
> nothing to say" only if you write **None**; left blank it reads as "not thought about yet", which is
> what this file exists to prevent.
>
> **On the frontmatter.** `status` is the honest state, not the ambition: `draft` while you are still
> arguing with it, `agreed` once the owner has signed off the shape, `in-build` while the PR is open,
> `shipped` when it merges. `verified` is narrower and is the one that decays: it means every row marked
> `[code]` in §3 was re-read against the tree, and it flips to `false` the moment the page is touched
> without re-checking. A spec that claims `verified: true` and disagrees with the code is worse than one
> that admits it is stale, because only the first is believed.

---

## 1. Purpose

*One sentence: what this page lets one actor do, in their words. If it takes two sentences, the page is
probably two pages. Name the actor from the glossary ([`../../CONTEXT.md`](../../CONTEXT.md)) - Visitor,
Guest, Owner, Staff - because who is asking decides disclosure, scoping, and the 404-vs-403 answer.*

---

## 2. Entry & exit

*Where a user arrives from, what they can leave to, and what the URL carries. The URL is part of the
contract, not an implementation detail ([`_list-pattern.md`](./_list-pattern.md) §5): a filtered or
selected view must be reproducible from the link alone.*

| | |
|---|---|
| **Arrives from** | *the pages, links, or emails that lead here, and whether a cold deep link must work* |
| **Exits to** | *every navigation out, including the ones on success and on failure* |
| **URL params** | *`$id` etc. - and what an unknown or malformed one does* |
| **Query state** | *the zod schema name (`features/…/…-search.ts`) and each param's meaning* |
| **Not in the URL** | *state that deliberately stays local - `_list-pattern.md` §5.2* |
| **Auth** | *public · authed · authed + owner-only. Staff-scoping consequences, if any (ADR-0032)* |

*Search params are external input and go through `validateSearch` at the route with `.catch(undefined)`
per field, so a pasted bad value opens the default view rather than crashing. Say here what each bad
value degrades **to**.*

---

## 3. Data requirements

*Every value the page renders, and where it comes from. Fill this in before writing a component: the row
with no Schema and no Endpoint is the field nobody has built yet, and finding it here costs minutes
instead of a mid-build detour.*

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| *Header* | *title* | `property.name` | `PropertyResponse` | `GET /properties/:id` | raw | [spec] |
| *Header* | *Verified badge* | `verified` | `propertyResponseSchema` | `GET /properties/:id` | BE | [code] |
| *Body* | *Archived pill* | `archivedAt` | `unitResponseSchema` + `propertyResponseSchema` | `GET /units` · `GET /properties` | FE | [code] |
| *Row* | *nights* | - | none found | - | FE | [code] |
| *Footer* | *payout total* | `payoutIdr` | **NEW** | - | - | [TBD] |

**Column rules:**

- **Region** - the area of the page (Header, Filters, Body, Row, Footer, Dialog). Group rows by it, so
  the table doubles as a layout inventory.
- **UI element** - what the user sees, in their words, not the component name.
- **Field** - the property as it is spelled on the wire (`camelCase`), so it greps. `-` when the value is
  assembled from others rather than carried.
- **Schema** - the **export name** from `packages/shared`, not the file. *This column is the point of the
  table: an export name is checked by `tsc`, so a spec that cites one cannot quietly drift from the
  contract, while prose describing "the property's name" can. Write `none found` when the value has no
  schema behind it, and **NEW** when one has to be added - a NEW here becomes work in §8.*
- **Endpoint** - the REST path, without the `/api` prefix (api-spec §1). One row, one endpoint; a value
  assembled from two reads is two rows plus an FE note.
- **Computed in** - one of:
  - **raw** - the server sent it and the page renders it as-is.
  - **BE** - the server derived it (a join, a flag, a total) and sent the answer.
  - **FE** - the browser decides it. Every `FE` here should have a matching row in §7, and if it is a
    business rule rather than layout, that row carries `leak: true`.
  *Why the distinction is worth the column: a value computed in two places is two definitions that will
  disagree, which is the drift [ADR-0012](../adr/0012-a-409-carries-a-code-not-a-sentence.md) and
  ADR-0010 both exist to prevent. Writing the side down forces the choice to be made once.*
- **Source** - where this row's claim came from:
  - **[spec]** - carried from [`../page-spec.md`](../page-spec.md). Inherited, not re-checked. page-spec
    is `status: legacy` and documents pages already built, so a `[spec]` row is a claim about what was
    *intended*.
  - **[code]** - derived by reading `apps/web/src` or `apps/api/src` at a known commit. This is the only
    value that supports `verified: true` in the frontmatter.
  - **[TBD]** - not determinable, and needs a decision. A `[TBD]` row must have a matching entry in §10.
  *Why provenance is a column and not a footnote: the two disagree more often than anyone expects, and a
  table that mixes "the spec says" with "the code does" without saying which is a document you cannot act
  on. Marking the source is what lets a reviewer trust the rows that were checked and challenge the rows
  that were not.*

---

## 4. Requests

*What the page asks for, and when. Reads here; writes go in §6.*

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /properties` | *on mount* | *no - chrome renders first* | *yes - `["properties"]`, already warm from the calendar* |
| `GET /bookings?from&to` | *on mount + whenever the window changes* | *body only* | *no - keyed by this page's filters* |

- **When called** - mount, on a param change, debounced on input, on an interval. If it polls, say what
  stops the poll.
- **Blocks render?** - what is unusable until it lands. The default is *chrome renders immediately, body
  waits* (`_list-pattern.md` §1.1); anything else is a delta and belongs in §5.
- **Mergeable?** - can this ride a cache key another page already holds (`["properties"]`, `["units"]`,
  `["settings"]`), or must it be its own entry? *Why ask: sharing the key is how two surfaces cannot
  disagree and how arriving from a sibling page costs no refetch (`_list-pattern.md` §6.5). Not sharing
  is sometimes right - the calendar and reservations ask `GET /bookings` genuinely different questions -
  but it should be a decision, not an accident.*

---

## 5. States

*Deltas from [`_list-pattern.md`](./_list-pattern.md) **only**. Do not restate loading, empty, error,
403/404, mutation feedback or skeleton behaviour that the pattern already covers. If this page follows
it, write **Follows the pattern** and move on.*

*What genuinely belongs here:*

- *empty-state **variants** and their exact copy, and how the page tells them apart (the pattern says
  read the URL, not the result count - §2.2)*
- *this page's partial-failure policy if it fans out (pattern §3.5: all-or-nothing, per-section, or
  degrade-and-retry) and why*
- *states the pattern has no opinion on: a countdown, a per-status body, a read-only view for Staff*
- *any rule deliberately broken, with the reason. If the reason generalises it belongs in the pattern
  instead, which is a separate PR.*

---

## 6. Interactions

*Every control that writes. The last two columns are the ones that get skipped and then cause bugs.*

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| *"Dismiss"* | `POST /sync-conflicts/:id/dismiss` | *button → "Working…"* | *invalidate `["sync-conflicts"]`* | *404 swallowed; other → inline* | *no* | *yes - guarded UPDATE* |

- **Feedback** - what changes on screen the instant it is pressed. Per-row actions get per-row pending
  state, never a page-wide spinner (pattern §6.1).
- **Success** - which cache keys are invalidated, and what the user sees. Invalidate by what the write
  **causally** changed, at the widest key that is true (pattern §6.3).
- **Failure** - split by class: 400 → field, 409 → a `conflictCodeSchema` slug rendered by
  `describeConflict`, other → one generic sentence (pattern §3.6). *Naming the 409 slug here is what makes
  the copy exist before the endpoint does.*
- **Optimistic?** - the codebase's answer so far is **no**: refetch the server's answer rather than
  patching the list, because a local edit is a second opinion about what is true (pattern §6.2).
  Departing from that needs a reason in writing.
- **Idempotent?** - can it fire twice (double click, retry, a racing tab) without a second effect? If no,
  say what stops it. *This is invariant #7 at the UI layer, and the row where "no" is the honest answer is
  the row that needs a design, not a note.*

Also record **does it confirm first?** Destructive and irreversible actions do; reversible ones
(archive/unarchive) do not (pattern §6.4). The confirm copy names the thing and the consequence.

---

## 7. Business rules

*The rules this page depends on, who owns each, and which field carries it. A rule is anything that
decides a domain fact, an eligibility, a permission, or money/date arithmetic - as opposed to layout,
copy, or colour.*

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| *A Unit priced at zero is not sellable* | BE | `basePriceIdr` → `isSellable()` | - |
| *Effective-archived = the Unit's flag OR its Property's* | FE | `archivedAt` (both) | `leak: true` |
| *The past is not selectable* | FE | *browser-local today* | - |

**The `leak: true` marker.** Set it on any FE row that is a **business rule**, not a browser question.
The name is the argument: a domain rule computed in the client has leaked out of the API, so it now
exists in two places that can disagree, and the client's copy is the one no constraint backstops.

Two FE rows are **not** leaks, and the distinction is worth being strict about:

- rules that are genuinely the browser's question - what "today" is in the guest's own timezone
  (ADR-0013's past-date guard), whether a lazily-imported chunk has arrived;
- rules that call a **shared** helper from `packages/shared`, so both sides run the same code
  (`isSellable`, `isArchived`, `depositAmountIdr`, `countNights`). One implementation in two runtimes is
  not two definitions.

Everything else is a leak, including a rule the API also enforces: the client copy is UX, the server is
correctness (invariant #5), and the spec should say which is authoritative. Recording it does not forbid
it - the codebase ships several deliberately - it makes the count visible, so nobody adds the fourth copy
of a rule by accident.

---

## 8. Schema implications

*What `packages/db` (and `packages/shared`) need that they do not have. **None** is a good answer and the
most common one - write it, because a blank section reads as unexamined.*

| Change | Table / package | Migration | Why |
|---|---|---|---|
| *`example.foo_at timestamptz null`* | `packages/db` | `0017_example_foo_at.sql` | *…* |
| *index on `(tenant_id, status)`* | `packages/db` | same | *the list's predicate* |
| *`ExampleResponse`* | `packages/shared` | n/a | *the wire shape §3 cites* |

- Every **NEW** in §3's Schema column resolves to a row here, or it is not actually new.
- Migrations are `NNNN_snake_case_subject.sql` in `packages/db/drizzle/`, numbered from the last on
  `main` (**0016** at the time of writing - check the directory, not this line). Naming it *before*
  building is what makes two parallel branches notice they both want `0017` while that is still a
  conversation rather than a merge conflict.
- Anything touching RLS, an exclusion constraint, or a composite FK is hand-written SQL in the migration,
  not a `db:generate` diff (`packages/db/src/schema.ts` header, db-design §3) - flag it here so review
  expects it.
- A DB CHECK that mirrors a shared constant is **hand-copied** (SQL cannot import TypeScript); say so and
  say what pins the pair, if anything does.
- A new inbound request schema is built with `strictObject`
  ([ADR-0031](../adr/0031-a-request-is-strict-a-response-is-lenient.md)); a route that takes no body
  carries `@NoBody()`. Responses stay lenient.

---

## 9. Out of scope

*What this page deliberately does **not** do, and where that thing lives instead. Two jobs: it stops
scope creep in review, and it is the first place to look when someone asks "why can't I do X here". Link
the page or issue that owns each exclusion.*

---

## 10. Open questions

*Decisions still owed, each with who owns it and what is blocked until it lands. Every `[TBD]` in §3 has a
line here. Delete a line when it is answered, and if the answer was architectural, log it in the CLAUDE.md
decision table or as an ADR rather than leaving it here. An empty section at `status: agreed` is the
point.*

- [ ] *question - **owner:** RacThug / builder - **blocks:** …*
