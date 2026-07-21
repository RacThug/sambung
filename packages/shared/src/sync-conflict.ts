/**
 * The sync-conflict inbox contract (#38, boss fight #3, ADR-0027, api-spec §7.5).
 *
 * A conflict is one imported VEVENT the `booking_no_overlap` exclusion constraint
 * refused: an OTA sold nights that overlap a booking Sambung already holds, i.e. a
 * real-world double-sell. The import records it and moves on (ADR-0025's per-VEVENT
 * savepoint); this contract is how the owner sees and closes them.
 *
 * Shared by api (frames the rows, validates the query) and web (the inbox section
 * and the per-connection badge).
 */
import { z } from "zod";
import { bookingSourceSchema, bookingStatusSchema } from "./booking";
import { channelSchema } from "./channel";

/**
 * Where a conflict is in its life - pinned to the `sync_conflict_status` pgEnum by a
 * test in apps/api (§8.6), the one workspace allowed to import both packages.
 *
 * The three are not one spectrum. `resolved` is a MEASUREMENT ("the constraint no
 * longer refuses this"), which the next sync re-takes and may reverse. `dismissed` is
 * a JUDGEMENT ("I looked, it's fine"), which re-detection must never undo - otherwise
 * a dismissed item reappears every cron tick and the inbox becomes noise the owner
 * learns to ignore (ADR-0027).
 */
export const syncConflictStatusSchema = z.enum([
  "open",
  "resolved",
  "dismissed",
]);
export type SyncConflictStatus = z.infer<typeof syncConflictStatusSchema>;

/**
 * A booking currently occupying the nights this conflict wants - DERIVED at read
 * time by overlapping the conflict's stay against the unit's occupying bookings,
 * never stored, because which booking blocks can change between reads (the owner
 * cancels one, a hold lapses).
 *
 * This is what makes the inbox actionable: api-spec §7.5 says resolution is "cancel
 * the blocking booking", so naming it turns a hunt through the reservations list into
 * one click through to `/app/bookings/:id`. Owner disclosure (a guest name), like
 * every other authed owner read.
 */
export const blockingBookingSchema = z.object({
  id: z.string().uuid(),
  source: bookingSourceSchema,
  status: bookingStatusSchema,
  checkIn: z.string().date(),
  checkOut: z.string().date(),
  guestName: z.string().nullable(),
});
export type BlockingBooking = z.infer<typeof blockingBookingSchema>;

/**
 * One conflict as the owner sees it (api-spec §7.5), plus the context needed to act
 * on it without a second request (the ADR-0022 "enough to act" grain): which property
 * and unit, which channel, which nights, and what is currently in the way.
 *
 * `stay` is half-open `[from, to)` - `to` is the check-out date, not a night
 * (invariant #4). There is deliberately NO raw VEVENT field: the parser drops a
 * feed's SUMMARY/DESCRIPTION so imported guest PII never enters (ADR-0025), and this
 * shape must not be the door that re-admits it.
 */
export const syncConflictSchema = z.object({
  id: z.string().uuid(),
  propertyId: z.string().uuid(),
  propertyName: z.string(),
  unitId: z.string().uuid(),
  unitName: z.string(),
  channel: channelSchema,
  externalUid: z.string(),
  stay: z.object({ from: z.string().date(), to: z.string().date() }),
  status: syncConflictStatusSchema,
  firstDetectedAt: z.string(), // ISO-8601 UTC
  lastSeenAt: z.string(), // ISO-8601 UTC
  closedAt: z.string().nullable(), // ISO-8601 UTC, set when it left `open`
  blockingBookings: z.array(blockingBookingSchema),
});
export type SyncConflict = z.infer<typeof syncConflictSchema>;

/**
 * Query for `GET /sync-conflicts` (api-spec §7.5). `status` defaults to `open` -
 * this is an inbox, and the thing an owner opens it for is what still needs them.
 * Single-valued rather than the repeatable set-param `GET /bookings` uses: that list
 * exists to be sliced many ways at once, whereas three mutually-interesting states
 * are a tab, not a filter matrix.
 *
 * `propertyId` narrows a multi-property owner to one workbench. Coerced from the
 * query string, so both sides can hand it straight to the URL.
 */
export const listSyncConflictsQuerySchema = z.object({
  status: syncConflictStatusSchema.default("open"),
  propertyId: z.string().uuid().optional(),
});
export type ListSyncConflictsQuery = z.infer<
  typeof listSyncConflictsQuerySchema
>;

/**
 * The 200 for `POST /sync-conflicts/:id/dismiss`. Echoes the resulting state rather
 * than assuming it: dismissing an already-closed conflict is an idempotent no-op that
 * reports what it actually is (`dismissed`, or `resolved` if the world healed it
 * first), so a double-click or a stale list is benign and needs no 409 code.
 *
 * There is no matching "resolve" endpoint by design (api-spec §7.5): resolving means
 * cancelling the blocking booking in the real world, which the next sync MEASURES.
 * A button that marked a conflict resolved without the constraint agreeing would be
 * the read disagreeing with the write.
 */
export const dismissSyncConflictResponseSchema = z.object({
  id: z.string().uuid(),
  status: syncConflictStatusSchema,
  closedAt: z.string().nullable(), // ISO-8601 UTC
});
export type DismissSyncConflictResponse = z.infer<
  typeof dismissSyncConflictResponseSchema
>;
