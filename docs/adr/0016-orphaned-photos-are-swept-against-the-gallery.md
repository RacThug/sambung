# ADR-0016: Orphaned photos are swept against the gallery, per tenant

- **Status:** Accepted
- **Date:** 2026-07-19
- **Issue:** #69 (deferred from #39; api-spec §4.5 "Orphaned objects are GC'd out-of-band")
- **Supersedes / relates:** ADR-0009 (the two-scope hold sweep — this reuses its cron-on-the-owner-connection shape)

## Context

Photo bytes live in S3-compatible storage (Garage dev / R2 prod, #39); the DB row
stores only the ordered keys in `property.photos`. Objects and gallery references
therefore drift apart, always in the direction of *orphans* — an object with no
gallery pointing at it:

- a presign mints a key and the browser PUTs bytes, but the owner never PATCHes
  it into the gallery (abandoned upload);
- a key is PATCHed in, then dropped from the set later — `PATCH /photos` is a
  whole-set replace, so the removed key's **object stays** (api-spec §4.5);
- an upload lands on a backend that does **not** enforce the signed
  `content-length`, so an object larger than `MAX_PHOTO_SIZE_BYTES` exists that no
  correct client could have produced.

Nothing reclaims these. Left alone they only cost storage, but the oversize case
is also a policy hole (the 5 MB cap is meant to be inviolable). #39 deferred the
reclaim as "GC'd out-of-band"; this is that GC.

## Decision

A daily `@Cron` sweep (`PhotoGcSweeperService`, in the storage module) on the
**owner connection** (`DbService`, RLS-bypassing) — the same shape as the M2 hold
sweeper (ADR-0009), for the same reason: a sweep that crosses tenants has no single
tenant to scope to.

Four load-bearing choices:

### 1. The gallery is the authority; the store is swept against it

The **referenced set** is the union of every `property.photos` across **all**
tenants, read once per sweep on the owner connection. A key in that set is
**never deleted**. This is the one invariant that matters — a bug here destroys a
real photo — so it is expressed as a positive membership test evaluated before any
delete decision, not inferred from age.

The direction is deliberate: the DB is the source of truth, the object store is the
cache that may hold extra bytes. We delete *from the store to match the DB*, never
the reverse.

### 2. Tenant-scoped listing is a safety boundary, not an optimisation

The sweep enumerates the `tenant` table, then lists objects **only under each
`<tenantId>/` prefix**. It never lists the bucket root. Two consequences:

- Non-photo objects (Garage's website `index.html`, any future system object) sit
  outside every tenant prefix and are structurally invisible to the sweep.
- The Garage object store is **shared across dev/CI worktree lanes**, while each
  lane's Postgres is **isolated**. A whole-bucket sweep would list another lane's
  objects — under a tenant UUID absent from *this* DB — find them "unreferenced,"
  and delete them. Scoping to prefixes of tenants this DB knows confines the sweep
  to objects it has authority over. The "tenant-scoped listing" acceptance
  criterion is this safety property.

A whole-bucket list + global diff would be one fewer round trip and simpler to
write. It is rejected precisely because it erases the authority boundary above.

### 3. A grace window, shiftable by the caller's clock

An unreferenced object is deleted only if its `LastModified` is older than a
**24 h grace window**. Younger unreferenced objects are left: they may be an
in-flight upload whose PATCH has not yet landed. (Presign URLs live 5 minutes, so
24 h never races a real upload — the window is deliberately enormous relative to
the risk.)

`sweep(now: Date)` takes the reference clock; the cron handler passes
`new Date()`. A test passes a **future** `now` to make a just-uploaded object fall
outside the window — exercising the real `PHOTO_GC_GRACE_MS` constant
deterministically, without faking an object's server-set mtime. This keeps the
grace semantics under test rather than trusted.

### 4. Oversize eviction is a grace-independent backstop that may mutate a gallery

`size > MAX_PHOTO_SIZE_BYTES` → the object is **evicted** (deleted) **and** its key
is stripped from whatever gallery references it (`array_remove`, cross-tenant safe
because the key is globally unique), and the event is **logged loudly** (`warn`).

No grace window applies: presign caps the upload size cryptographically, so an
oversize object is never a legitimate in-flight upload — it is only ever the
residue of a non-enforcing backend, and immediate eviction is the backstop's whole
point. This is the *one* place the sweep writes to `property.photos`; everywhere
else it only ever deletes bytes the DB already stopped pointing at.

## Consequences

- Idempotent by construction: a second run re-reads the referenced set and re-lists
  the (now smaller) object set; nothing already deleted is re-considered, and the
  grace + membership tests are pure functions of state.
- Safe on an empty bucket / empty prefix: an empty `Contents` yields no candidates.
- The sweep reads the `property` table directly via `DbService`, bypassing
  `PropertiesRepository` — mirroring how `HoldSweeperService` reads `booking`
  directly. A tenant-scoped repository cannot express a cross-tenant sweep.
- Cost: one `ListObjectsV2` page-walk per tenant per day plus one referenced-set
  read. At portfolio scale this is negligible; if a tenant ever holds >1000 objects
  the list paginates and the batch delete chunks at 1000.
- Not a boss fight, but it **deletes storage** on a **shared** store, so it was
  built test-first with the "referenced object survives even when old" invariant
  proven hard, on test-owned keys only.
