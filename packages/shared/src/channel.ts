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
export const createChannelConnectionRequestSchema = z.object({
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
 * Deliberately NOT carrying `openConflicts` (spec'd in §7.2): the sync-conflict
 * inbox belongs to the iCal IMPORT pipeline (#38, boss fight #3), which is a
 * separate M4 issue - there is no `sync_conflict` table to count yet, and a
 * hard-coded 0 would be a field with no source. It joins this shape when the
 * import side lands.
 */
export const channelConnectionResponseSchema = z.object({
  id: z.string().uuid(),
  unitId: z.string().uuid(),
  channel: channelSchema,
  importIcalUrl: z.string(),
  lastSyncedAt: z.string().nullable(), // ISO-8601 UTC or null
  lastStatus: syncStatusSchema,
  lastError: z.string().nullable(),
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
 */
export const syncConnectionResponseSchema = z.object({
  lastStatus: syncStatusSchema,
  lastSyncedAt: z.string().nullable(), // ISO-8601 UTC or null
  lastError: z.string().nullable(),
  imported: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});
export type SyncConnectionResponse = z.infer<
  typeof syncConnectionResponseSchema
>;
