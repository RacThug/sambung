import { SYNC_STALE_AFTER_MINUTES } from './channel-sync.constants';

/**
 * Is this feed's last good pull too old? (REQ-AV-04, spec FR-01/FR-04/FR-05.)
 *
 * Judged HERE, on the API process's clock - which is the same clock that stamped
 * `last_synced_at` (ChannelsService.connect and the importer both write
 * `new Date()`). That symmetry is the whole point. Shipping the threshold to the
 * browser and letting it compare would judge one clock against another: a laptop
 * twenty minutes fast would warn about a healthy feed, one twenty minutes slow
 * would stay quiet about a dead one, and neither user would know why.
 *
 * Derived on every read, stored nowhere - the same rule as effective-archived
 * (api-spec §4.6, ADR-0005). A boolean column would need a job to keep true, and
 * "the row that says everything is fine" is exactly the row that stops updating
 * when the process minding it dies.
 *
 * Two deliberate edges:
 * - `null` (never synced) is NOT stale. "Never checked" and "checked, long ago"
 *   are different facts with different next actions - wait, versus go and look at
 *   the URL you pasted.
 * - `lastStatus` is not consulted. A feed erroring since its last good pull three
 *   days ago is BOTH erroring and three days behind, and the owner needs both
 *   numbers; a red pill that hides the age understates the damage.
 */
export function isStale(lastSyncedAt: Date | null, now: Date): boolean {
  if (lastSyncedAt === null) return false;
  return lastSyncedAt.getTime() < staleCutoff(now).getTime();
}

/** The instant a successful pull must be newer than to count as fresh. Exposed
 * so the fleet aggregate can push the same judgement into SQL as one bound
 * parameter, rather than re-deriving the rule in a second place. */
export function staleCutoff(now: Date): Date {
  return new Date(now.getTime() - SYNC_STALE_AFTER_MINUTES * 60_000);
}
