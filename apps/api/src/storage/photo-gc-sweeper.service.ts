import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { property, tenant } from '@sambung/db';
import { MAX_PHOTO_SIZE_BYTES } from '@sambung/shared';
import { DbService } from '../db/db.service';
import { StorageService, type StorageObject } from './storage.service';
import { PHOTO_GC_CRON, PHOTO_GC_GRACE_MS } from './storage.constants';

/** What one sweep reclaimed - returned for logging and asserted in tests. */
export interface PhotoGcResult {
  /** Unreferenced objects older than the grace window, deleted. */
  deletedOrphans: number;
  /** Objects over the size cap, deleted + stripped from any gallery. */
  evictedOversize: number;
}

/**
 * The orphaned-photo GC sweep (ADR-0017, #69, deferred from #39). Photo BYTES
 * live in object storage; the DB row stores only the keys (`property.photos`).
 * They drift apart - abandoned uploads, keys dropped from a gallery whose object
 * lingers, oversize objects a non-enforcing backend accepted - always leaving
 * ORPHANS (an object no gallery points at). This reclaims them.
 *
 * It runs on the OWNER connection (DbService, RLS-bypassing), the same shape as
 * the M2 hold sweeper (ADR-0009) and for the same reason: a sweep that crosses
 * tenants has no single tenant to scope to. The DB is the authority - we delete
 * FROM the store to match the gallery, never the reverse.
 *
 * Single VPS = one process, so the @Cron fires once per tick - no distributed
 * lock. Idempotent besides: every decision is a pure function of current state
 * (the referenced set + each object's size/age), so a second run re-derives it.
 */
@Injectable()
export class PhotoGcSweeperService {
  private readonly logger = new Logger(PhotoGcSweeperService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly storage: StorageService,
  ) {}

  @Cron(PHOTO_GC_CRON)
  async sweepOrphanedPhotos(): Promise<PhotoGcResult> {
    return this.sweep(new Date());
  }

  /**
   * The testable core. `now` is the reference clock for the grace window: the
   * cron passes `new Date()`, a test passes a future instant to make a
   * just-uploaded object fall outside the window without faking its server-set
   * mtime (ADR-0017 §3).
   *
   * `tenantIds` narrows the sweep to specific tenants; omitted (the cron path),
   * it sweeps every tenant. The narrowing exists so a caller can run a targeted
   * GC - and so a test on the SHARED object store can confine its sweep to its
   * own tenant's prefix, never touching another suite's in-flight objects.
   */
  async sweep(now: Date, tenantIds?: string[]): Promise<PhotoGcResult> {
    // The authority: every key any gallery references, across ALL tenants, in
    // one read on the owner connection. A key in here is NEVER deleted - the one
    // invariant that matters, so it's the first test on every object below.
    // Kept global even when the sweep is narrowed: a broader protected set can
    // only ever SPARE more, never cause a wrongful delete.
    const referenced = await this.referencedKeys();
    const cutoff = now.getTime() - PHOTO_GC_GRACE_MS;

    // Tenant-scoped listing is a SAFETY boundary, not an optimisation (ADR-0017
    // §2): we only ever list objects under a `<tenantId>/` prefix belonging to a
    // tenant THIS database knows. Objects outside any tenant prefix (Garage's
    // index.html) or under a foreign tenant (another dev/CI lane sharing the
    // bucket) are structurally invisible, so the sweep can never delete them.
    const ids = tenantIds ?? (await this.allTenantIds());

    const orphanKeys: string[] = [];
    const oversizeKeys: string[] = [];

    for (const id of ids) {
      const objects = await this.storage.listObjects(`${id}/`);
      for (const obj of objects) {
        if (obj.size > MAX_PHOTO_SIZE_BYTES) {
          // Oversize backstop: no grace window (presign caps the upload size, so
          // an oversize object is never a legitimate in-flight upload) and it
          // wins over referenced status - an oversize object must not sit in a
          // gallery at all.
          oversizeKeys.push(obj.key);
        } else if (!referenced.has(obj.key) && this.isOld(obj, cutoff)) {
          orphanKeys.push(obj.key);
        }
      }
    }

    // Oversize eviction mutates galleries (the one place the sweep writes). Strip
    // the key from whatever property references it, then delete the bytes, and
    // log LOUDLY - an oversize object means a backend let one past the signed
    // content-length, which the operator should see.
    for (const key of oversizeKeys) {
      if (referenced.has(key)) {
        await this.stripFromGallery(key);
      }
      this.logger.warn(
        `Evicting oversize photo object (> ${MAX_PHOTO_SIZE_BYTES} bytes): ${key}`,
      );
    }

    await this.storage.deleteObjects([...oversizeKeys, ...orphanKeys]);

    const result: PhotoGcResult = {
      deletedOrphans: orphanKeys.length,
      evictedOversize: oversizeKeys.length,
    };
    if (result.deletedOrphans > 0 || result.evictedOversize > 0) {
      this.logger.log(
        `Photo GC swept: ${result.deletedOrphans} orphan(s) deleted, ` +
          `${result.evictedOversize} oversize evicted`,
      );
    }
    return result;
  }

  /** Every tenant id (owner connection) - the cron's full sweep scope. */
  private async allTenantIds(): Promise<string[]> {
    const rows = await this.dbs.db.select({ id: tenant.id }).from(tenant);
    return rows.map((r) => r.id);
  }

  /**
   * The union of every `property.photos`, across all tenants (owner connection).
   * `unnest` flattens the arrays in the DB; `distinct` de-dupes; the Set makes
   * the "is this referenced?" test O(1). A key appears here iff some gallery
   * points at it, which is exactly what spares it from deletion.
   */
  private async referencedKeys(): Promise<Set<string>> {
    const rows = await this.dbs.db
      .select({ key: sql<string>`unnest(${property.photos})` })
      .from(property);
    return new Set(rows.map((r) => r.key));
  }

  /**
   * Remove a key from whatever gallery references it. Cross-tenant safe without
   * a tenant filter because a key is globally unique (`<tenant>/<property>/<uuid>`),
   * so only its owning property matches - and this runs on the owner connection,
   * which must reach across tenants by design.
   */
  private async stripFromGallery(key: string): Promise<void> {
    await this.dbs.db
      .update(property)
      .set({ photos: sql`array_remove(${property.photos}, ${key})` })
      .where(sql`${key} = any(${property.photos})`);
  }

  /**
   * True iff the object is older than the grace window. An object with no
   * LastModified (should not happen) is treated as too-new - we never reclaim
   * something we can't date.
   */
  private isOld(obj: StorageObject, cutoff: number): boolean {
    return (
      obj.lastModified !== undefined && obj.lastModified.getTime() < cutoff
    );
  }
}
