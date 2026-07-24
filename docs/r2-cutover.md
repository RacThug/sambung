# Moving photo storage to Cloudflare R2

**Read this before pointing production at R2.** It is the runbook for the one
backend swap the architecture promises is "a single env change" (§3.6) — and for
the two things that swap cannot verify on its own.

Origin: issue #68, decided in [ADR-0029](./adr/0029-a-cutover-is-verified-by-a-probe.md).

---

## What is actually being swapped

Nothing in the code. `StorageService` speaks the S3 API and is configured
entirely by `STORAGE_*` env vars; Garage (dev, `docker compose`) and R2 (prod)
are the same code path. What changes is which bucket the env names — and what
that bucket does with the guarantees the photo pipeline leans on.

Three of those guarantees are **not ours to enforce**:

| Guarantee | Enforced by | Holds on Garage | Holds on R2 |
|---|---|---|---|
| Only whitelisted image types can be uploaded | the signed `Content-Type` header | yes | **documented yes** — Cloudflare: "uploads will fail with `403/SignatureDoesNotMatch` if the client sends a different `Content-Type`" |
| The 5 MB cap survives past presign time | the signed `Content-Length` header | yes | **undocumented** — measure it (see below) |
| A browser may PUT directly to the bucket | the bucket CORS policy | applied on boot by `STORAGE_BOOTSTRAP` | dashboard/wrangler only |

That table is why this is a runbook and not a checkbox.

---

## 1. Create the bucket (dashboard)

1. Cloudflare dashboard → **R2** → *Create bucket*. Note the **account ID** — the
   S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
2. **R2 activation requires a payment method on file.** Cost stays **$0** inside
   the free tier (10 GB storage, zero egress), but the card is mandatory. This
   was flagged when the backend was chosen (invariant #8, ADR log 2026-07-16).
   **If a card on file is unacceptable**, the documented fallback is Garage on
   the VPS — *identical code path*, only `STORAGE_ENDPOINT` and
   `STORAGE_PUBLIC_BASE_URL` differ. Everything below still applies except this
   step; the probe in §4 is the same instrument either way.
3. **R2 API token**: R2 → *Manage API tokens* → create a token with **Object
   Read & Write** scoped to this bucket. It yields an access key id + secret.

## 2. Configure CORS (dashboard)

Without this, uploads fail in a real browser on the preflight — while every
server-side check stays green, because Node has no same-origin policy.

R2 → your bucket → **Settings → CORS Policy → Add**:

```json
[
  {
    "AllowedOrigins": ["https://sambung.example"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`AllowedOrigins` is the **public site origin** — the same value as
`WEB_BASE_URL`, because that is the page the guest's browser is on when it PUTs.

> `STORAGE_BOOTSTRAP` stays **unset** in prod. It is the dev-only Garage path
> (`PutBucketCors` + `PutBucketWebsite` on boot), and R2 supports neither call
> over the S3 API — it would fail as a mere log warning while CORS stayed
> unconfigured. The API now **refuses to boot** in production if it is `true`.

## 3. Enable public access (dashboard)

R2 → your bucket → **Settings → Public access → Connect a custom domain**, e.g.
`photos.sambung.example`. Use a custom domain rather than the `r2.dev`
development URL: `r2.dev` is rate-limited and explicitly not for production.

Then set `STORAGE_PUBLIC_BASE_URL` to that origin, **no trailing slash**.

> The API never fetches this URL, so a wrong value has *no* server-side symptom
> — it produces a broken `<img>` in a guest's browser and nothing else. The API
> now refuses to boot in production if it is http or a loopback host (the
> half-swapped-env case), and §4 fetches it for real.

## 4. Point the env at R2 and run the probe

In the VPS env (never the repo — invariant: prod secrets live only there):

```dotenv
# Set this FIRST. EVERY production guard in validate-env.ts is gated on it, and
# nothing in this repo sets it for you - `start:prod` is a bare `node dist/main`
# and there is no Dockerfile. Without it a prod process keeps dev behaviour
# silently, including honouring STORAGE_BOOTSTRAP - which on the documented
# Garage-on-VPS fallback would really rewrite the live bucket's CORS on boot.
NODE_ENV="production"
STORAGE_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
STORAGE_REGION="auto"
STORAGE_BUCKET="sambung-photos"
STORAGE_ACCESS_KEY_ID="<from step 1.3>"
STORAGE_SECRET_ACCESS_KEY="<from step 1.3>"
STORAGE_PUBLIC_BASE_URL="https://photos.sambung.example"
# STORAGE_BOOTSTRAP intentionally absent
```

Then:

```bash
pnpm --filter api storage:doctor
```

It boots no app and touches no database. It probes six things against whatever
bucket the env names, writing scratch objects under a random `<uuid>/<uuid>/`
prefix and deleting them on the way out:

| Probe | Catches |
|---|---|
| `reachable` | wrong endpoint / region / key / bucket, named once instead of five times |
| `presigned PUT round-trip` | signing broken against this backend at all |
| `content-type is enforced` | the whitelist not holding past presign time |
| `content-length is enforced` | the 5 MB cap not holding past presign time — **reported as a finding, see §5** |
| `public URL serves the object anonymously` | step 3 wrong: photos render broken, silently |
| `CORS allows a browser PUT` | step 2 missing: uploads die in the browser only |

A **FAIL** means do not cut over. A **NOTE** is a measurement — record it in §5.
Exit status is `0` when nothing failed, `1` otherwise, so it can gate a deploy step.

Two things the CORS probe will tell you that are worth reading carefully:

- **`(absent)`** — no CORS policy is configured. This is what R2 returns before
  step 2, and it is the whole reason the probe exists.
- **`allowed by a WILDCARD policy (any origin)`** — a pass, but the origin
  allowlist is not narrowing anything. Against **dev Garage this is expected**:
  `STORAGE_BOOTSTRAP` deliberately applies `"AllowedOrigins": ["*"]`, because one
  bucket is shared by every dev/e2e stack and an origin-per-boot policy let the
  last API to start lock the others out of their own uploads (#182). Against
  **R2 it means the pasted policy is `["*"]`** where it should name the site
  origin — worth fixing in the dashboard, even though the probe passes.

> Do not read the wildcard line as proof that a policy was applied. The verdict
> reads the preflight **status** as well as the header, so a wrong-origin policy
> and no policy at all both **FAIL** — but until the #182 review they did not:
> Garage attaches `access-control-allow-origin: *` to its 403 refusals, so all
> three states printed the same `[PASS] … WILDCARD` line. If you are reading an
> older transcript, that line proves nothing about the bucket.

> **Do not** verify by pointing `jest properties-photos` at production. That
> suite registers tenants (`beforeAll` → `POST /api/auth/register`), so it
> writes to whatever `DATABASE_URL` names, and it cleans up only if it reaches
> teardown. It also cannot fail on missing CORS or a bad public base. It remains
> the right regression guard **against dev Garage**, which is all it was ever
> for. This is [ADR-0029](./adr/0029-a-cutover-is-verified-by-a-probe.md).

## 5. Record what was measured

The one genuinely open question is `content-length`. Cloudflare documents
`Content-Type` enforcement and is silent on `Content-Length`, so it is settled
by the probe, not by reading.

**Either answer is safe to cut over on**, and #68's original conditional — "decide
whether the orphan-GC backstop (#69) must land first" — is **resolved: it landed**
(2026-07-20, [ADR-0017](./adr/0017-orphaned-photos-are-swept-against-the-gallery.md)).
Its oversize eviction is *grace-independent*, so:

- **Enforced** → the cap is refused at upload, as on Garage. Nothing to do.
- **Not enforced** → the cap holds at presign time, and an oversize object that
  slips past is evicted by the 03:00 sweep, which also strips the key from its
  gallery and logs loudly. The cap degrades from *"enforced at upload"* to
  *"enforced within a day"*. The exposure is a tenant oversizing **their own**
  gallery — presign is authenticated and tenant-scoped, so this is a quota risk,
  never a data or cross-tenant risk.

Append the result here when the cutover happens:

| Date | Backend | `content-type` | `content-length` |
|---|---|---|---|
| 2026-07-21 | Garage v2.3.0 (dev) | enforced (403) | enforced (403) |
| _pending_ | Cloudflare R2 (prod) | _measure_ | _measure_ |

The Garage row is the probe's own baseline — it is what `storage:doctor` prints
today against `docker compose`, and it is why a red result against R2 can be read
as "R2 differs" rather than "the probe is broken".

## 6. Smoke-test the real thing

The probe proves the storage layer. These prove the product:

- [ ] Dashboard → a property → upload a photo → it appears in the gallery.
- [ ] Open `/p/<slug>` in a **private window** → the photo renders (this is the
      anonymous public path, and the one `storage:doctor` approximates).
- [ ] Share `/p/<slug>` into WhatsApp → the preview card shows the photo. This
      also closes #60's AC #4 (link-preview verification needs live crawlers and
      a real public origin — it cannot be done from a worktree).

---

## Rolling back

There is no data migration and no schema change, so rollback is the env going
back. Photos uploaded to R2 stay in R2; a gallery whose keys point at a bucket
the env no longer names renders broken (the rows are untouched). If you have
written real photos to R2 and want to return to Garage, copy the objects across
(`rclone` between two S3 endpoints) before switching `STORAGE_ENDPOINT` back —
the keys are identical on both sides, so nothing in the database changes.
