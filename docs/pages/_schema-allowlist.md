# Accepted absences - the docs-doctor allowlist

> **What this is:** the two ledgers `pnpm docs:doctor` reads when something in the codebase has no
> page spec behind it. Every entry needs a **reason**, and the probe fails on an entry that has none.
> **What this is not:** a suppression list. An entry here is a claim that the absence is *correct*, and
> it is reviewed like any other claim - see [ADR-0038](../adr/0038-a-page-spec-is-checked-against-the-code.md).
>
> The probe also fails on a **stale** entry: allowlist something a page spec then goes on to cover, and
> it tells you to delete the line. The ledger cannot quietly outlive the reason it was written for.

---

## Schemas with no page

Every `*Schema` export of `packages/shared` must be cited by at least one page spec, or appear here.

| Schema | Reason |
|---|---|
| `bookingRefusalReasonSchema` | Embedded, never named on a page: refusal reasons reach the UI inside `conflictBodySchema`'s `dates_unavailable` body and inside `availabilityResponseSchema.reasons`, both of which pages do cite. |
| `createOwnerBookingResponseSchema` | The 201 from the calendar's block / walk-in dialog. `apps/api` frames the response; the dialog reads none of it and closes on success (`app-calendar.md` §6). Recorded as a response with no reader, not as a documentation gap. |
| `healthResponseSchema` | `GET /health` is a liveness probe with no page and no FE consumer (`sitemap.md` §4, "Machine & edge"). |
| `importIcalUrlSchema` | Embedded in `createChannelConnectionRequestSchema`, which `app-properties-propertyId.md` cites. |
| `inviteTokenSchema` | Embedded in `acceptInviteRequestSchema` and used as a path-param bound; `invite-token.md` cites the request schema. |
| `meResponseSchema` | `GET /auth/me` has no FE consumer, so no page can cite it. Kept deliberately rather than deleted: api-spec §3.5 specifies a behaviour that differs from `refresh` on purpose (a stale seat is a `401` here, a fallback there) and documents the two composing as `401 → refresh → retry`. The **type** `MeResponse` is used by the controller and service; it is the zod schema that has no runtime caller, the response being framed by type rather than parse - which is a smaller finding than MIGRATION-REPORT.md §6c claimed. |
| `noBodyRequestSchema` | The `@NoBody()` guard's contract (ADR-0031, #152). It describes the *absence* of a body on sixteen routes; there is nothing for a page to render. |
| `paymentProviderSchema` | Provider identity rides on `paymentSessionResponseSchema` and `lapsedPaymentSchema`; neither page renders the field (`p-slug-book.md` §3, `app-inbox.md` §3 both record it as carried-but-unrendered). |
| `presignPhotoRequestSchema` | The upload request body. The workbench cites the *response* (`presignPhotoResponseSchema`), which is what it renders; the request is composed from a `File` the user picked. |
| `rupiahSchema` | The money primitive. It is inside every price field on every page rather than being a field itself (`money.ts`, invariant #6). |
| `syncConflictStatusSchema` | A conflict's `status` is fetched and deliberately not rendered: the inbox shows only open conflicts, so the field would say "open" on every row (`app-inbox.md` §3, §10). |

---

## Routes with no page spec

Every route in [`../sitemap.md`](../sitemap.md) §2 must have a page spec in this directory, or appear
here.

| Route | Reason |
|---|---|
| `/` | [`../page-spec.md`](../page-spec.md) §6 declares a landing page **out of scope** for v1 and says the root redirects to login. A landing page shipped anyway (#60 follow-up), so there was nothing to migrate and the spec contradicts the code. Writing one is a decision, not a transcription (MIGRATION-REPORT.md §1). |

---

## How to remove an entry

Write the page spec, or delete the export. Then run `pnpm docs:doctor`: it will tell you the entry is
stale and must go. That is the intended direction of travel - this file should get shorter.
