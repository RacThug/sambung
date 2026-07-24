# ADR-0029: A cutover is verified by a probe, not by the test suite

- **Date**: 2026-07-21
- **Status**: Accepted (amended 2026-07-24 by #193 - see "Two production-only boot guards" below: the guards are no longer keyed on `NODE_ENV`)
- **Issue**: #68 (deferred from #39)
- **Builds on**: ADR-0017 (the orphaned-photo sweep, which is this decision's backstop), architecture §3.6 (S3-compatible storage, backend swapped by env)

## Context

The photo pipeline was designed so that moving prod storage from Garage to Cloudflare R2 is a single env swap. That is true of the *code*. It is not true of the *guarantees*, because three of them are enforced by the backend rather than by us:

- the content-type whitelist holds after presign time only because `Content-Type` is a **signed header** and storage refuses a mismatch;
- the 5 MB cap holds after presign time only because `Content-Length` is a **signed header** and storage refuses a mismatch;
- a browser may PUT at all only because the bucket carries a **CORS policy**.

Garage honours all three. Cloudflare documents the first ("uploads will fail with `403/SignatureDoesNotMatch`"), says **nothing** about the second, and requires the third to be set from its dashboard — `PutBucketCors` over the S3 API, which `STORAGE_BOOTSTRAP` uses against Garage, is not supported.

So the swap is exactly one env edit and three unverified assumptions, two of which fail **silently**: a wrong `STORAGE_PUBLIC_BASE_URL` yields broken `<img>` tags in a guest's browser and no server-side symptom whatsoever; a missing CORS policy breaks browser uploads while every server-side probe stays green.

#68 prescribed a verification: point `apps/api/.env` at R2 and run `pnpm --filter api jest properties-photos`. That instruction is wrong in three ways, and the third is the interesting one.

1. **It is destructive.** That suite's `beforeAll` calls `POST /api/auth/register` twice. It writes tenants and properties to whatever `DATABASE_URL` names, and removes them only if it reaches `afterAll`. It asks an operator to point a tenant-creating suite at a live database in order to test an object store.
2. **It is coupled.** Verifying "can I reach my bucket" should not require a Postgres, a full Nest boot, and a JWT.
3. **It is structurally blind to two of the three assumptions.** The suite PUTs from Node, which has no same-origin policy, so it *cannot* fail on missing CORS. And it never reads `STORAGE_PUBLIC_BASE_URL`, so it cannot fail on unreachable public photos. It would have gone green on a bucket that could not serve a single photo to a single browser.

## Decision

**A cutover is verified by a dedicated probe that talks only to the configured backend; the test suite stays pointed at dev Garage; and the two mis-sets with no server-side symptom are made boot-fatal.**

Three parts.

**1. `pnpm --filter api storage:doctor`** (`apps/api/scripts/storage-doctor.ts`) — boots no app, opens no database connection, and drives **the same `StorageService` the API uses**, never a re-implementation. It probes: reachability; a presigned PUT round-trip; content-type enforcement; content-length enforcement; that `STORAGE_PUBLIC_BASE_URL` serves the object **anonymously**; and that a real `OPTIONS` preflight from the site origin is allowed. It writes under a random `<uuid>/<uuid>/` prefix and deletes in a `finally`.

**2. Content-length is reported as a FINDING, not a failure.** It is the one answer that cannot be looked up, and either answer is safe to cut over on — so the probe measures it and `docs/r2-cutover.md` records it, rather than blocking.

**3. Two production-only boot guards** in `validateEnv`: `STORAGE_PUBLIC_BASE_URL` must be https and non-loopback, and `STORAGE_BOOTSTRAP` must not be `true`.

> **Amended 2026-07-24 (#193).** "Production-only" originally meant `NODE_ENV === 'production'` - a variable **nothing in this repo sets**, so both guards were inert on a real deployment unless an operator remembered one env var with no other visible effect. They now fire whenever the process cannot **prove** it is a local sandbox, the proof being that every browser-facing origin it declares (`WEB_BASE_URL`, `STORAGE_PUBLIC_BASE_URL`) is loopback. `NODE_ENV=production` remains sufficient but is no longer necessary. The asymmetry argued below - guard the browser-facing value, never `STORAGE_ENDPOINT` - is what made that derivation available: the same value that "can never be loopback in production" is also the one that says whether this *is* production.

The manual residue — create bucket, add card, paste CORS JSON, bind custom domain — is irreducibly a human with a dashboard, and lives in `docs/r2-cutover.md` beside `deploy/Caddyfile` rather than in a closed issue.

## Why

**The probe must run the app's own code, or it proves things about itself.** This is the same read-can't-disagree-with-write rule the codebase applies to every other pair of paths that could drift: the owner calendar and the guest funnel share one `quote()` (ADR-0011), reconcile-on-read and the webhook share one transition (ADR-0020), the crawler card and the rendered page share one `buildPropertyOgTags` (ADR-0019). A doctor that re-derived its own presigning would be a second definition of "a valid upload," green against a bucket the app cannot use.

**Separate instrument, not a reused suite, because the two have opposite safety requirements.** `pnpm test` must be safe to run at any moment and must never reach a production bucket. A cutover probe must *deliberately* be pointed at production. A test that can be pointed at prod is a hazard sitting in the suite; a script that is only ever run on purpose is not. Splitting them also lets the probe have a vocabulary jest does not: `FINDING`, for a measurement whose answer is not a verdict.

**A boot guard, not a line in the runbook, for the two silent mis-sets.** The runbook says what to set; nothing makes anyone read it. These two are the failure modes with *no server-side evidence at all* — no exception, no log line, no failing request — so a documentation-only mitigation is indistinguishable from none. This is the same category as `WEB_BASE_URL` (#127): a production misconfiguration whose only symptom appears in a stranger's browser, so the boot seam is where it is caught. Both stay production-only, so dev and every suite are untouched.

**`STORAGE_ENDPOINT` is deliberately *not* guarded the same way.** The documented fallback if R2's card-on-file requirement is unacceptable is Garage on the VPS (architecture §3.6), where `http://localhost:3900` is the *correct* production endpoint. `STORAGE_PUBLIC_BASE_URL` has no such exception: it is browser-facing, so it can never be loopback, and on an https site a plain-http URL is blocked as mixed content before it is fetched. The asymmetry is the point — guard the value that is provably always wrong, not the one that merely looks like it.

**#68's open conditional is resolved rather than re-decided.** It asked whether the orphan-GC backstop must land before cutover if R2 ignores signed content-length. #69 shipped on 2026-07-20 (ADR-0017) with *grace-independent* oversize eviction, so the answer is already yes-and-it-did. If R2 does not enforce content-length, the cap degrades from "enforced at upload" to "enforced within a day", and the exposure is a tenant oversizing **their own** gallery — presign is authenticated and tenant-scoped, so it is a quota risk, never a data or cross-tenant one.

## Consequences

- A backend swap is now a one-command question with a printed answer, so the same probe serves the R2 cutover, the Garage-on-VPS fallback, and any future backend.
- A half-swapped production env fails at boot with a message naming the variable and the runbook, instead of shipping broken images or dead uploads.
- The probe **writes real objects** to whatever bucket it is pointed at. They are deleted in a `finally` and sit under a tenant id no database knows — invisible to the GC sweep, which lists only the prefixes of tenants it can see (ADR-0017) — but a hard kill mid-run leaves a handful of scratch objects, and the script prints their keys if cleanup fails.
- `docs/r2-cutover.md` §5 must be updated with the measured content-length answer at cutover, or the ADR's premise silently rots.
- The probe cannot verify the crawler/link-preview path or anything else needing a live public origin; those stay owner checklist items (#60 AC #4).
