/**
 * Channel connection contract (FR-SYNC-1/2, api-spec §7.1/7.2/7.4/7.6) - the
 * M4 lifecycle: connect an OTA iCal URL to a Unit, list connections with their
 * sync health, disconnect. Shared by api (validates the body at the boundary,
 * frames the response) and web (the channels section on the property workbench,
 * page-spec §4.5).
 *
 * The public `.ics` EXPORT feed (§7.6) has no shape here: it is a `text/calendar`
 * body only machines (OTAs) consume, never JSON the web reads - so it lives
 * entirely server-side (apps/api/channel-sync/ical.ts).
 */
import { z } from "zod";

import { strictObject } from "./strict";

/**
 * The OTA a connection points at. A closed set: the owner picks from these three
 * (api-spec §7.1), and the exclusion constraint on `(unit_id, channel)` treats it
 * as an identity, so a free string would let two "airbnb" spellings both connect.
 *
 * NOT pinned to a pgEnum: `channel_connection.channel` is `text` (db-design §3),
 * because a channel is Sambung's word for an external system - the same reasoning
 * that keeps `payment.provider` text (payment.ts). The zod boundary is the only
 * gate, which is why it must be closed here.
 */
export const channelSchema = z.enum(["airbnb", "booking_com", "vrbo"]);
export type Channel = z.infer<typeof channelSchema>;

/**
 * sync health - pinned to the `sync_status` pgEnum by a test in apps/api (§8.6),
 * the one workspace that may import both packages/db and packages/shared. The web
 * must never import packages/db (invariant #1), so this list is hand-copied and
 * only the pin test keeps the copies honest.
 *
 * `never` = connected but not yet smoke-fetched; `ok` = the last pull reached a
 * real iCal feed; `error` = it did not (with a human reason in `lastError`).
 * Failures surface, never silent (FR-SYNC-3).
 */
export const syncStatusSchema = z.enum(["never", "ok", "error"]);
export type SyncStatus = z.infer<typeof syncStatusSchema>;

/**
 * The import URL an owner pastes from the OTA (api-spec §7.1). MUST be https - an
 * http feed would be a cleartext fetch the server makes on the owner's behalf, and
 * an OTA never publishes one. Validated here at the boundary (invariant: trust no
 * external input); the server additionally smoke-fetches it once on connect, and
 * a private/loopback host is refused at fetch time (SSRF hygiene), not here, since
 * that needs the resolved connection rather than the URL's shape.
 */
export const importIcalUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  // `.url()` guarantees a parseable URL; the refine narrows the scheme to https.
  // A string prefix check (not `new URL().protocol`) keeps this file free of the
  // DOM lib, which the shared tsconfig omits - and after `.url()` a leading
  // `https://` is an unambiguous scheme.
  .url()
  .refine((value) => /^https:\/\//i.test(value), {
    message: "must be an https URL",
  });

/** Body of `POST /units/:id/channels` (api-spec §7.1). The unit id is in the
 * PATH; the tenant is the caller's own (owner RLS connection). */
export const createChannelConnectionRequestSchema = strictObject({
  channel: channelSchema,
  importIcalUrl: importIcalUrlSchema,
});
export type CreateChannelConnectionRequest = z.infer<
  typeof createChannelConnectionRequestSchema
>;

/**
 * One connection as the owner sees it (api-spec §7.2). `lastSyncedAt` is the last
 * time a pull reached a real feed (null until one does); `lastStatus` + `lastError`
 * surface the health (FR-SYNC-3). `importIcalUrl` is echoed so the UI can show
 * what an owner connected without re-typing it.
 *
 * `openConflicts` was deferred when this shape shipped (#55) - there was no
 * `sync_conflict` table to count, and a hard-coded 0 would have been a field with no
 * source. #38 built the table, so it now has one: how many imported VEVENTs this
 * connection currently cannot land because they overlap an existing booking (a
 * real-world double-sell). A non-zero count is health information exactly like
 * `lastStatus` - the feed is reachable and parsing fine, yet not everything in it is
 * making it in (FR-SYNC-3: failures surface, never silent).
 */
export const channelConnectionResponseSchema = z.object({
  id: z.string().uuid(),
  unitId: z.string().uuid(),
  channel: channelSchema,
  importIcalUrl: z.string(),
  lastSyncedAt: z.string().nullable(), // ISO-8601 UTC or null
  lastStatus: syncStatusSchema,
  lastError: z.string().nullable(),
  /**
   * Is `lastSyncedAt` too old to trust? (REQ-AV-04.) Derived server-side on every
   * read, never stored - and deliberately NOT computable here, because the
   * threshold is a fact about the server's sweep cadence and the comparison must
   * happen on the clock that stamped the timestamp. The browser phrases the age;
   * the server judges it.
   *
   * Independent of `lastStatus`: a feed can be `error` AND three days behind, and
   * both belong on screen. A `never`-synced feed is not stale - it is unstarted.
   */
  stale: z.boolean(),
  openConflicts: z.number().int().nonnegative(),
  createdAt: z.string(), // ISO-8601 UTC
});
export type ChannelConnectionResponse = z.infer<
  typeof channelConnectionResponseSchema
>;

/**
 * The 200 for `DELETE /channels/:id` (api-spec §7.4). Disconnecting KEEPS every
 * already-imported booking - they may reflect real stays, and the API never
 * auto-cancels a confirmed booking (ADR 2026-07-16) - so it reports how many
 * remain, letting the owner clean up deliberately rather than losing reality
 * silently. `importedBookingsKept` is data the web composes copy from (#82).
 */
export const disconnectChannelResponseSchema = z.object({
  importedBookingsKept: z.number().int().nonnegative(),
});
export type DisconnectChannelResponse = z.infer<
  typeof disconnectChannelResponseSchema
>;

/**
 * The 200 for `POST /channels/:id/sync` - "Sync now" (api-spec §7.3, #56). The
 * pull runs SYNCHRONOUSLY (there is no job queue on a single VPS - ADR-0025), so
 * the response reports the connection's post-sync health, not a `{ queued: true }`
 * promise. `lastStatus`/`lastSyncedAt`/`lastError` are the same health fields the
 * list carries (FR-SYNC-3); `imported`/`cancelled` summarise what THIS pull did -
 * events reconciled, and OTA-side cancellations reflected. Both are 0 on an
 * unhealthy feed (nothing changed), so a `lastStatus: 'error'` response is
 * unambiguous.
 *
 * `conflicts` (#38) counts VEVENTs this pull could NOT land because they overlap a
 * booking Sambung already holds - a real-world double-sell, now filed in the inbox.
 * It is reported separately from `imported` rather than folded into `lastStatus:
 * 'error'` on purpose: the feed was perfectly healthy, and the owner needs "3 in, 1
 * clashed" rather than a red badge that hides the 3.
 */
export const syncConnectionResponseSchema = z.object({
  lastStatus: syncStatusSchema,
  lastSyncedAt: z.string().nullable(), // ISO-8601 UTC or null
  lastError: z.string().nullable(),
  imported: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});
export type SyncConnectionResponse = z.infer<
  typeof syncConnectionResponseSchema
>;

/**
 * The 200 for `POST /channels/sync` - "Sync now" for every feed the caller can
 * see, from the calendar (api-spec §7.5). Same synchronous pull as the
 * per-connection route above (ADR-0025: no queue on one VPS), just fanned over
 * the caller's connections, so this is a SUM rather than one feed's health.
 *
 * `feeds` is how many were attempted, and it is reported rather than derived so
 * "nothing happened" can be told apart from "nothing to do": `feeds: 0` means no
 * OTA calendar is connected yet, while `feeds: 3, imported: 0` means three healthy
 * feeds had nothing new. `errored` counts feeds that came back unhealthy - the
 * owner still needs to know WHICH, so the per-feed status on the property
 * workbench stays the place that answers that.
 *
 * Scope note: "every feed the caller can see" is RLS's answer, not a parameter -
 * for staff, that is their assigned properties only (ADR-0032's second axis).
 */
export const syncAllResponseSchema = z.object({
  feeds: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});
export type SyncAllResponse = z.infer<typeof syncAllResponseSchema>;

/**
 * The 200 for `GET /channels/health` (api-spec §7.7, REQ-AV-04) - how current the
 * whole calendar is, in one cheap read, for the page where availability is
 * actually looked at.
 *
 * `oldestSyncedAt` is the OLDEST successful pull among the visible feeds, not the
 * newest. A calendar is only as current as its stalest feed: three feeds where the
 * freshest synced two minutes ago and one has been silent six hours is not a
 * two-minute-old calendar, and reporting the newest would be a flattering lie
 * (ADR-0040). It is null when ANY visible feed has never synced - there is no
 * complete freshness claim to make - and `feeds` + `neverSynced` are what let the
 * UI tell "nothing connected" apart from "connected, never pulled".
 *
 * The counts are reported rather than a single verdict because the owner's next
 * action differs per shape: `erroring` sends them to the feed's URL, `stale`
 * suggests the sweep itself has stopped, `neverSynced` just means wait.
 */
export const syncHealthResponseSchema = z.object({
  feeds: z.number().int().nonnegative(),
  erroring: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  neverSynced: z.number().int().nonnegative(),
  oldestSyncedAt: z.string().nullable(), // ISO-8601 UTC or null
});
export type SyncHealthResponse = z.infer<typeof syncHealthResponseSchema>;
