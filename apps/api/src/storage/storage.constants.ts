/**
 * Photo GC sweep timings (ADR-0017, #69). Constants, not env: these are product
 * rules (an abandoned upload is reclaimed after a day), not per-deploy knobs.
 */

/**
 * How long an UNREFERENCED object is spared before it's treated as an orphan and
 * deleted. The window exists so the sweep can NEVER race an in-flight upload: a
 * browser presigns a key, PUTs the bytes, then PATCHes it into the gallery - for
 * the moments between the PUT and the PATCH the object is real but unreferenced.
 *
 * Presign URLs live 5 minutes (PRESIGN_EXPIRES_SECONDS), so a legitimate upload
 * is fully referenced within minutes; 24 h is enormous relative to that risk on
 * purpose. Referenced objects are spared regardless of age - the window only
 * decides how long an ORPHAN is tolerated, never whether a real photo lives.
 */
export const PHOTO_GC_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The sweep cadence. Unlike the hold sweep (every 5 min - a dead hold blocks a
 * booking, so it's time-critical), an orphan only wastes storage, so daily is
 * plenty. Runs at 03:00 to avoid the (thin) daytime traffic. One VPS = one
 * process, so the @Cron fires once per tick; the sweep is idempotent besides.
 */
export const PHOTO_GC_CRON = '0 3 * * *'; // daily at 03:00
