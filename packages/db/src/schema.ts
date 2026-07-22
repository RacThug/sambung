/**
 * Sambung database schema (Drizzle). See docs/db-design.md for the rationale.
 *
 * Everything Drizzle CAN express lives here - tables, enums, single-column and
 * COMPOSITE foreign keys (the tenant-consistency FKs of db-design §4.5), CHECK
 * constraints, and the partial unique index for iCal dedupe.
 *
 * What it cannot express - the `booking_no_overlap` GiST EXCLUDE constraint
 * (boss fight #1) and the RLS policies (boss fight #5) - is hand-written SQL
 * appended to the baseline migration in ./drizzle. That is safe from drift:
 * drizzle-kit diffs schema snapshots against each other, never against the
 * database, so hand-added SQL in a migration is never "reverted".
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// citext: case-insensitive text (extension created in the baseline migration).
const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

// ---- Enums ------------------------------------------------------------------
export const userRole = pgEnum("user_role", ["owner", "staff"]);
export const syncStatus = pgEnum("sync_status", ["never", "ok", "error"]);
export const bookingSource = pgEnum("booking_source", [
  "direct",
  "airbnb",
  "booking_com",
  "vrbo",
  "manual_block",
]);
export const bookingStatus = pgEnum("booking_status", [
  "pending_payment",
  "confirmed",
  "cancelled",
  "expired",
]);
export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "paid",
  "failed",
]);
// The lifecycle of one sync conflict (#38, ADR-0027). `open` = an imported VEVENT
// the exclusion constraint still refuses; `resolved` = the world fixed itself (the
// blocking booking was cancelled, or the OTA withdrew its event) - a MEASUREMENT the
// next sync re-takes; `dismissed` = the owner judged it a non-issue, which re-detection
// must never undo. That asymmetry is the whole reason there are three states and not
// two (ADR-0027: dismiss is a judgement, resolve is a measurement).
export const syncConflictStatus = pgEnum("sync_conflict_status", [
  "open",
  "resolved",
  "dismissed",
]);

// ---- Tenancy ------------------------------------------------------------------
export const tenant = pgTable(
  "tenant",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    // How many photos ONE Property's Gallery may hold, for this tenant (#67,
    // ADR-0030). A preference, not a quota: the guard is PHOTO_GALLERY_CEILING
    // in @sambung/shared, and this is the tenant's own line inside it. Lives on
    // `tenant` rather than in a settings table because one knob does not earn a
    // table - the same call as property.deposit_pct.
    //
    // Editable via PATCH /settings (owner role only). Lowering it never touches
    // a photo: the service refuses only requests that GROW a gallery past the
    // cap, so an over-cap gallery stays readable, reorderable and shrinkable.
    galleryCap: smallint("gallery_cap").notNull().default(30),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Mirrors galleryCapSchema in @sambung/shared. Same reasoning as
    // property_deposit_pct_range: the app validates for the message, the DB
    // backstops a bypassed app check. Raising the ceiling is a migration on
    // purpose - it is a product decision, not a config tweak.
    check("tenant_gallery_cap_range", sql`${t.galleryCap} between 1 and 100`),
  ],
);

export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // GLOBALLY unique, not per-tenant: login is `email + password` with no
    // tenant in the request, so two rows sharing an address would make "which
    // account is this?" unanswerable. The consequence is real and deliberate -
    // one person cannot be staff at two Tenants with one address (#57).
    email: citext("email").notNull().unique("app_user_email_key"),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("staff"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Composite-FK target for user_property_app_user_tenant_fk and
    // staff_invite_created_by_tenant_fk (#57, the #40 pattern one table over).
    unique("app_user_id_tenant_uniq").on(t.id, t.tenantId),
  ],
);

// ---- Inventory ------------------------------------------------------------------
export const property = pgTable(
  "property",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    // The public address: `/p/:slug` (api-spec §4.7). GLOBALLY unique, not
    // per-tenant, because the URL carries no tenant - the slug is what tells a
    // guest's request which tenant it belongs to (ADR-0003).
    //
    // Minted once at create and never moved by a rename (ADR-0004). No DB
    // default: the value comes from slugifyName, and a row without one would be
    // a property with no public page.
    slug: text("slug").notNull(),
    address: text("address"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    description: text("description"),
    // NIB / KBLI 55193 → drives the "Verified" badge
    licenseNo: text("license_no"),
    // Ordered object-storage keys (`<tenant_id>/<property_id>/<uuid>.<ext>`),
    // array order = gallery order. Bytes live in S3-compatible storage (#39);
    // the row stores only keys. Publishability needs at least one.
    photos: text("photos").array().notNull().default(sql`'{}'::text[]`),
    // Retirement flag (ADR-0005, #84). NULL = active. Archiving a Property hides
    // its Units by DERIVATION: effective-archived reads this OR the unit's own
    // flag, so archiving never writes to unit rows and unarchive restores exactly
    // the Units that weren't retired on their own account. Set by a transition
    // (POST /properties/:id/archive), so - like slug - it is in no request schema.
    archivedAt: timestamptz("archived_at"),
    // The Deposit: share of a booking's total collected online at checkout
    // (ADR-0015, #52). Per-Property percent, 1-100, default 100 (pay in full).
    // The pay endpoint multiplies totalPriceIdr by this (BigInt, floored) to get
    // the amount charged and snapshots it onto the payment row; a booking always
    // keeps its FULL price, this only scales what is taken now. Editable via
    // PATCH /properties/:id (api #10) - unlike slug/archivedAt it IS in a request
    // schema, because it is a setting the owner tunes, not a transition.
    depositPct: smallint("deposit_pct").notNull().default(100),
    // The Property's local clock (ADR-0028, #145). Its ONLY reader is the iCal
    // import: a UTC-stamped VEVENT (`20260801T163000Z`) names no calendar date
    // until a zone is named, so without this the parser took the UTC date and
    // imported the block a night early. A stay itself stays timezone-free -
    // check_in/check_out are `date` columns (invariant #4) - so this converts at
    // the boundary and is never carried into the ledger.
    //
    // Editable via PATCH /properties/:id, like deposit_pct: a setting the owner
    // tunes, not a transition.
    timeZone: text("time_zone").notNull().default("Asia/Makassar"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Composite-FK target for unit_property_tenant_fk (db-design §4.5, #40).
    unique("property_id_tenant_uniq").on(t.id, t.tenantId),
    // THE check on slug uniqueness, not a backstop for one. An app-level
    // pre-check is impossible here: RLS hides the other tenants' rows we would
    // collide with, so "is this slug free?" always answers yes. The mint loop
    // asks this index instead, via ON CONFLICT DO NOTHING (properties.service).
    //
    // Deliberately NOT in the constraint map: with ON CONFLICT it never raises,
    // so if it ever does, some path skipped the mint - a bug, therefore a 500.
    unique("property_slug_key").on(t.slug),
    // Mirrors SLUG_PATTERN in @sambung/shared. The slug is server-derived, not
    // external input, so this guards our own slugify rather than a caller: a
    // malformed slug means a broken URL, and that should fail at the write.
    check("property_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    // A percent, not a money amount: 1-100. 0 would mean "pay nothing to book",
    // which is not this pay-to-confirm funnel (ADR-0015). Mirrors depositPctSchema
    // in @sambung/shared - the DB backstops a bypassed app check, like the price
    // bounds above.
    check("property_deposit_pct_range", sql`${t.depositPct} between 1 and 100`),
    // A CLOSED set, not free IANA text, and not an FK to pg_timezone_names.
    // Postgres CANNOT validate an arbitrary zone here: `AT TIME ZONE` is STABLE
    // (the tz database changes under you), and a CHECK admits only IMMUTABLE
    // expressions - so free text would leave the one column whose entire purpose
    // is correctness as the only one with no DB backstop. A lookup table would
    // restore the gate but make validity depend on the host's tz database
    // version, so dev and the VPS could disagree about what is storable.
    //
    // Mirrors propertyTimeZoneSchema in @sambung/shared. Widening it - a property
    // outside Indonesia - is a migration on purpose: that is a product decision.
    check(
      "property_time_zone_known",
      sql`${t.timeZone} in ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')`,
    ),
  ],
);

/**
 * Staff scoping: which Properties a staff user may touch (#57).
 *
 * This table is not merely a convenience list - it is READ BY RLS. The
 * `app_property_visible()` policy helper (migration 0015) consults it for every
 * row of property/unit/booking/channel_connection/sync_conflict/payment a staff
 * session touches, so a row here is literally the difference between a Property
 * existing and not existing for that user (ADR-0032).
 *
 * That is why `tenant_id` is here at all. Without it the pair
 * (staff of tenant A, property of tenant B) was representable, and the row it
 * would have made grants cross-tenant visibility - the follow-up #40 deferred
 * with "user_property has no tenant_id column, so cross-tenant staff assignment
 * is revisited when staff invites land". They landed.
 */
export const userProperty = pgTable(
  "user_property",
  {
    appUserId: uuid("app_user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade", onUpdate: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => property.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // Denormalized, like unit/booking (db-design §4.5) - and load-bearing twice
    // over: it carries the composite FKs below, AND it lets this table's own RLS
    // policy be a flat `tenant_id = <guc>`. That flatness is not cosmetic. If
    // this policy still resolved the tenant through `property`, then property's
    // new policy (which reads user_property) and user_property's policy (which
    // would read property) would reference each other - infinite recursion in
    // the planner. Denormalizing breaks the cycle.
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.appUserId, t.propertyId] }),
    // The two halves of "a staff member may only be assigned Properties of
    // their OWN Tenant" - unrepresentable, not an app-code obligation (#40).
    foreignKey({
      name: "user_property_app_user_tenant_fk",
      columns: [t.appUserId, t.tenantId],
      foreignColumns: [appUser.id, appUser.tenantId],
    }).onDelete("cascade"),
    foreignKey({
      name: "user_property_property_tenant_fk",
      columns: [t.propertyId, t.tenantId],
      foreignColumns: [property.id, property.tenantId],
    }).onDelete("cascade"),
    // The lookup RLS makes on every scoped row: "is THIS property assigned to
    // the current staff user?" The PK is (app_user_id, property_id), so that
    // exact probe is already an index-only scan - no extra index needed.
  ],
);

/**
 * An Invite: a Tenant's offer of a staff account, addressed to one email and
 * carrying the Properties that account will be able to see (#57, ADR-0033).
 *
 * The row holds a SHA-256 of the token, never the token itself. The token is
 * 256 bits of CSPRNG output, so it needs no key-stretching (bcrypt exists to
 * make LOW-entropy secrets expensive to guess; a hash is the right tool for a
 * secret that is already unguessable), and hashing means a database dump cannot
 * be replayed into a session.
 */
export const staffInvite = pgTable(
  "staff_invite",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // citext like app_user.email: the person who accepts types their address
    // back, and case must not decide whether an invite matches.
    email: citext("email").notNull(),
    // sha256 hex of the token. UNIQUE because it is the lookup key - accept
    // resolves an invite by hashing what the caller presented.
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    // The three ways an invite stops being live. All nullable timestamps rather
    // than a status enum: each is a distinct event with its own moment, and
    // "live" is derived from their absence - the same derive-don't-store grain
    // as archived_at and payment.handled_at.
    acceptedAt: timestamptz("accepted_at"),
    revokedAt: timestamptz("revoked_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade", onUpdate: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("staff_invite_token_hash_key").on(t.tokenHash),
    // Composite-FK target for staff_invite_property.
    unique("staff_invite_id_tenant_uniq").on(t.id, t.tenantId),
    // The inviter belongs to the Tenant they invite into.
    foreignKey({
      name: "staff_invite_created_by_tenant_fk",
      columns: [t.createdBy, t.tenantId],
      foreignColumns: [appUser.id, appUser.tenantId],
    }).onDelete("cascade"),
    // At most ONE live invite per (tenant, email). Partial, because accepted and
    // revoked invites are history and must be allowed to pile up - re-inviting
    // someone whose first invite lapsed has to work. Mapped to
    // `409 invite_already_pending` (ADR-0012), so the owner is told to revoke or
    // wait rather than silently minting a second link to the same seat.
    uniqueIndex("staff_invite_live_email_uniq")
      .on(t.tenantId, t.email)
      .where(sql`"accepted_at" is null and "revoked_at" is null`),
  ],
);

/**
 * The Properties one Invite grants. A join table rather than a `uuid[]` column
 * on staff_invite, for two reasons that are both about the DB doing the work:
 * the composite FK makes a cross-tenant Property in an invite unrepresentable
 * (same guarantee as user_property), and a Property deleted between invite and
 * accept simply cascades out of the grant instead of exploding at accept time.
 */
export const staffInviteProperty = pgTable(
  "staff_invite_property",
  {
    inviteId: uuid("invite_id")
      .notNull()
      .references(() => staffInvite.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => property.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.inviteId, t.propertyId] }),
    foreignKey({
      name: "staff_invite_property_invite_tenant_fk",
      columns: [t.inviteId, t.tenantId],
      foreignColumns: [staffInvite.id, staffInvite.tenantId],
    }).onDelete("cascade"),
    foreignKey({
      name: "staff_invite_property_property_tenant_fk",
      columns: [t.propertyId, t.tenantId],
      foreignColumns: [property.id, property.tenantId],
    }).onDelete("cascade"),
  ],
);

export const unit = pgTable(
  "unit",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => property.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // denormalized (db-design §4.5) - kept consistent by unit_property_tenant_fk
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    // integer rupiah, never float (invariant #6)
    basePriceIdr: bigint("base_price_idr", { mode: "bigint" }).notNull(),
    maxGuests: integer("max_guests").notNull().default(2),
    minStay: integer("min_stay").notNull().default(1),
    // Retirement flag (ADR-0005, #84). NULL = active. Effective-archived is this
    // OR the parent property's archived_at - derived, not cascaded. "Active" (not
    // archived) is a DIFFERENT axis from isSellable (priced): a Unit counts toward
    // publishable only when it is both. The booking chokepoint (§5.3), not this
    // column's presence in a WHERE, is what makes selling an archived Unit a bug.
    archivedAt: timestamptz("archived_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Composite-FK target for booking/channel_connection tenant FKs (#40).
    unique("unit_id_tenant_uniq").on(t.id, t.tenantId),
    // A Unit is ONE sellable thing (ADR-0001), so an owner with 8 identical
    // rooms creates 8 rows - which makes near-identical names the common case,
    // not the exception. Scoped to the property: two properties may each have a
    // "Garden Room"; the same property may not. Case-sensitive on purpose -
    // being told "Garden Room" is taken while looking at a list showing
    // "garden room" confuses more than the near-duplicate it would prevent.
    //
    // Not cosmetic: M4 wires an OTA iCal feed per unit (#28) from a dropdown
    // labelled by name. Two rows reading "Garden Room" and the owner connects
    // Airbnb's calendar for one into the other - a real overbooking that no
    // exclusion constraint can catch, because the bookings don't overlap, they
    // are just on the wrong unit.
    unique("unit_property_name_uniq").on(t.propertyId, t.name),
    // unit.tenant_id must equal its property's tenant_id - a mismatch is
    // unrepresentable, not an app-code obligation (db-design §4.5).
    foreignKey({
      name: "unit_property_tenant_fk",
      columns: [t.propertyId, t.tenantId],
      foreignColumns: [property.id, property.tenantId],
    }).onDelete("cascade"),
    check("unit_base_price_nonneg", sql`${t.basePriceIdr} >= 0`),
    // Upper bound mirrors MAX_NIGHTLY_RATE_IDR in @sambung/shared (kept in sync by
    // hand - SQL can't import the constant). A DOMAIN ceiling on a nightly rate,
    // and the layer that makes the #47 quote overflow unrepresentable even to a
    // raw insert: base_price_idr x 366 nights stays far under MAX_SAFE_INTEGER, so
    // toRupiah can't overflow and 500 the no-auth endpoint. Rejected twice over
    // (#45): zod rejects it at the API, this CHECK behind a bypass.
    check("unit_base_price_max", sql`${t.basePriceIdr} <= 1000000000`),
    check("unit_max_guests_positive", sql`${t.maxGuests} > 0`),
    check("unit_min_stay_positive", sql`${t.minStay} >= 1`),
  ],
);

// ---- Channels ------------------------------------------------------------------
// Archive (ADR-0005, #84) does NOT touch these rows - it is inventory-only. Two
// M4 constraints ride on that: (1) the iCal EXPORT feed must stay archive-blind
// for a Unit that still has bookings, or archiving would tell an OTA those nights
// are free and cause a real double-booking; (2) whether iCal IMPORT keeps running
// against an archived Unit is an M4 decision. Recorded here because M4 is where
// they get enforced.
export const channelConnection = pgTable(
  "channel_connection",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => unit.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
    channel: text("channel").notNull(), // 'airbnb' | 'booking_com' | 'vrbo'
    importIcalUrl: text("import_ical_url").notNull(),
    lastSyncedAt: timestamptz("last_synced_at"),
    lastStatus: syncStatus("last_status").notNull().default("never"),
    lastError: text("last_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "channel_connection_unit_tenant_fk",
      columns: [t.unitId, t.tenantId],
      foreignColumns: [unit.id, unit.tenantId],
    }).onDelete("cascade"),
    // One connection per (unit, channel) - api-spec §7.1 (#55). A Unit is ONE
    // sellable thing (ADR-0001), so its Airbnb calendar has exactly one feed;
    // a second would be the owner wiring the same OTA in twice. THE guard: an
    // app-level pre-check races (two connects in flight both pass it), so this
    // constraint is what actually enforces it, mapped to `channel_already_connected`
    // so a lost race and the pre-check answer identically (api-spec §5.3).
    unique("channel_connection_unit_channel_uniq").on(t.unitId, t.channel),
  ],
);

/**
 * The sync-conflict inbox (#38, boss fight #3, ADR-0027, db-design §4.8).
 *
 * When an OTA sells nights that overlap an existing occupying booking, a real-world
 * double-sell has happened out there, and the `booking_no_overlap` exclusion
 * constraint refuses the import (`23P01`). That refusal is CORRECT - but the losing
 * VEVENT is then a fact that exists nowhere: no booking row, and the feed is
 * transient. This is the one place Sambung stores what it cannot derive.
 *
 * It is an OPS INBOX, never an availability source - nothing in the availability or
 * booking path reads this table, so invariant #3 is untouched. A conflict blocks
 * nothing; it asks a human to go pick the loser in the real world, because money and
 * a guest are attached to both sides and the machine must not choose (ADR 2026-07-16).
 *
 * No raw VEVENT is kept. ADR-0025's parser deliberately drops SUMMARY/DESCRIPTION so
 * imported guest PII cannot enter through the feed; storing the raw block here would
 * re-admit exactly that through a side door. The uid + unit + nights are what an
 * owner needs to phone the OTA (ADR-0027).
 */
export const syncConflict = pgTable(
  "sync_conflict",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Denormalized for RLS, like booking/unit (db-design §4.5) - and load-bearing
    // rather than a backstop here, because the WRITER is the RLS-bypassed owner
    // connection (the import cron). The composite FK below is what makes a wrong
    // tenant_id unrepresentable instead of merely discouraged.
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // Cascade, unlike booking's `set null`: a booking is LEDGER and outlives its
    // connection, but a conflict is an ops todo ABOUT a feed. Disconnect the
    // channel and the todo is moot (ADR-0027).
    channelConnectionId: uuid("channel_connection_id")
      .notNull()
      .references(() => channelConnection.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => unit.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // NOT NULL (unlike booking.external_uid): the parser skips a UID-less VEVENT
    // before it can ever reach the insert that conflicts, so every conflict has one.
    externalUid: text("external_uid").notNull(),
    // The refused stay, half-open [check_in, check_out) like every other date pair
    // (invariant #4). Two `date` columns, NOT a `daterange`: the only daterange in
    // this schema is built inline inside the exclusion constraint, and a second
    // idiom for the same fact is how drift starts (ADR-0027).
    checkIn: date("check_in", { mode: "string" }).notNull(),
    checkOut: date("check_out", { mode: "string" }).notNull(),
    status: syncConflictStatus("status").notNull().default("open"),
    firstDetectedAt: timestamptz("first_detected_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    // When it stopped being `open`, whichever exit it took. Nullable, and the only
    // thing dismiss writes besides the status - the same shape as payment.handled_at
    // (ADR-0022): annotate in place, destroy nothing.
    closedAt: timestamptz("closed_at"),
  },
  (t) => [
    // Idempotent re-detection (AC #2): re-polling a still-conflicting feed UPDATEs
    // one row instead of growing the inbox every 30 minutes. A plain unique
    // constraint, not booking's PARTIAL index, because both columns are NOT NULL.
    unique("sync_conflict_connection_uid_uniq").on(
      t.channelConnectionId,
      t.externalUid,
    ),
    // The inbox read: open conflicts for one tenant.
    index("sync_conflict_tenant_status_idx").on(t.tenantId, t.status),
    // tenant_id must equal its unit's tenant_id (db-design §4.5, #40). Cascade is
    // right here (unlike booking's `no action`): an inbox item is not the ledger,
    // so it has no claim to outlive the inventory it points at.
    foreignKey({
      name: "sync_conflict_unit_tenant_fk",
      columns: [t.unitId, t.tenantId],
      foreignColumns: [unit.id, unit.tenantId],
    }).onDelete("cascade"),
    check("sync_conflict_stay_nonempty", sql`${t.checkOut} > ${t.checkIn}`),
  ],
);

// ---- Bookings (the heart) ---------------------------------------------------
// Availability is DERIVED from these rows - there is no availability table
// (invariant #3). Stay dates are half-open [check_in, check_out) (invariant #4)
// and stored as plain 'YYYY-MM-DD' strings (mode: "string") - calendar dates,
// no timezone footguns.
export const booking = pgTable(
  "booking",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // denormalized for RLS - kept consistent by booking_unit_tenant_fk
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // no action, NOT cascade: deleting inventory must never destroy the ledger
    // (ADR-0002). See the twin composite FK below - BOTH must refuse, or the
    // survivor cascades the booking away and the check passes against zero rows.
    unitId: uuid("unit_id")
      .notNull()
      .references(() => unit.id, { onDelete: "no action", onUpdate: "cascade" }),
    source: bookingSource("source").notNull(),
    status: bookingStatus("status").notNull(),
    checkIn: date("check_in", { mode: "string" }).notNull(),
    checkOut: date("check_out", { mode: "string" }).notNull(),
    guestName: text("guest_name"), // null for manual_block / some imports
    // Guest contact is STRUCTURED (not one free-text blob) because WhatsApp is
    // the confirmation channel and M3's wa.me deeplink needs a real number.
    // All three stay NULLABLE: "required" is an API-boundary rule for
    // source=direct, exactly like guest_name - manual_block and imported
    // bookings have no guest we collected details from (migration 0007, #48).
    guestPhone: text("guest_phone"),
    guestEmail: text("guest_email"),
    guestCount: integer("guest_count"), // party size; checked <= max_guests at the boundary
    totalPriceIdr: bigint("total_price_idr", { mode: "bigint" }),
    externalUid: text("external_uid"), // iCal VEVENT UID, idempotent re-sync
    channelConnectionId: uuid("channel_connection_id").references(
      () => channelConnection.id,
      { onDelete: "set null", onUpdate: "cascade" },
    ),
    holdExpiresAt: timestamptz("hold_expires_at"), // pending_payment hold TTL
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("booking_unit_status_idx").on(t.unitId, t.status),
    index("booking_tenant_idx").on(t.tenantId),
    // Idempotent imports: one feed event = exactly one row per connection.
    // Partial: only real iCal UIDs are deduped (db-design §4.7).
    uniqueIndex("booking_external_uid_uniq")
      .on(t.channelConnectionId, t.externalUid)
      .where(sql`${t.externalUid} is not null`),
    // booking.tenant_id must equal its unit's tenant_id (db-design §4.5, #40).
    //
    // `no action`, not `cascade` (ADR-0002). The cascade -> not-cascade part is
    // what matters; `no action` vs `restrict` is a tie-break, not a mechanism.
    // Both are non-deferrable AFTER-row checks at end of statement, so both
    // refuse deleting a unit with bookings AND both still allow account closure
    // (tenant -> property -> unit -> booking) - measured, see migration 0003.
    // `no action` is Postgres's default and the only one that could later be
    // made DEFERRABLE.
    foreignKey({
      name: "booking_unit_tenant_fk",
      columns: [t.unitId, t.tenantId],
      foreignColumns: [unit.id, unit.tenantId],
    }).onDelete("no action"),
    check("booking_stay_nonempty", sql`${t.checkOut} > ${t.checkIn}`),
    check(
      "booking_total_price_nonneg",
      sql`${t.totalPriceIdr} is null or ${t.totalPriceIdr} >= 0`,
    ),
    // Party size, when set, is a real headcount. Nullable (manual_block/imports
    // carry none), so the CHECK is null-tolerant - the DB backstops the boundary
    // rule 1 <= guest_count <= max_guests without forbidding an absent one.
    check(
      "booking_guest_count_positive",
      sql`${t.guestCount} is null or ${t.guestCount} > 0`,
    ),
    // NOTE - boss fight #1: the booking_no_overlap GiST EXCLUDE constraint is
    // NOT expressible in Drizzle. It lives as hand-written SQL in the baseline
    // migration (./drizzle) and cannot be drift-dropped (see file header).
  ],
);

// ---- Payments ------------------------------------------------------------------
export const payment = pgTable(
  "payment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text("provider").notNull(), // 'midtrans' | 'xendit'
    providerRef: text("provider_ref"), // order_id / transaction id
    amountIdr: bigint("amount_idr", { mode: "bigint" }).notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    // The owner's "I've dealt with this" marker for the paid-but-lapsed inbox
    // (#120, ADR-0022). NULL = still awaiting reconciliation; a timestamp = the
    // owner acknowledged it. Set ONLY by POST /payments/:id/handle, and it touches
    // ONLY this column - never payment.status / booking.status (ADR-0002: the
    // ledger is never mutated to clear an inbox item). Nullable so the marker is
    // reversible by construction - nothing is destroyed. No RLS change: `payment`'s
    // policy is row-level (scoped through the booking join), so a new column is
    // already tenant-isolated.
    handledAt: timestamptz("handled_at"),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check("payment_amount_nonneg", sql`${t.amountIdr} >= 0`)],
);

// Idempotent webhooks: each provider event recorded exactly once (db-design §4.7).
export const paymentEvent = pgTable(
  "payment_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    bookingId: uuid("booking_id").references(() => booking.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    // The verified provider payload, kept WITH the event it records (#53,
    // migration 0010). Distinct from payment.raw_payload, which holds the open
    // Snap session a pay-retry reads back (ADR-0015): the webhook never touches
    // that, so a failure event can't destroy a still-usable session.
    rawPayload: jsonb("raw_payload"),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [
    unique("payment_event_provider_event_uniq").on(t.provider, t.providerEventId),
  ],
);

// ---- Row types ------------------------------------------------------------------
export type Tenant = typeof tenant.$inferSelect;
export type AppUser = typeof appUser.$inferSelect;
export type UserProperty = typeof userProperty.$inferSelect;
export type StaffInvite = typeof staffInvite.$inferSelect;
export type Property = typeof property.$inferSelect;
export type Unit = typeof unit.$inferSelect;
export type ChannelConnection = typeof channelConnection.$inferSelect;
export type SyncConflict = typeof syncConflict.$inferSelect;
export type Booking = typeof booking.$inferSelect;
export type Payment = typeof payment.$inferSelect;
export type PaymentEvent = typeof paymentEvent.$inferSelect;
export type UserRole = (typeof userRole.enumValues)[number];
export type BookingSource = (typeof bookingSource.enumValues)[number];
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
export type SyncConflictStatus = (typeof syncConflictStatus.enumValues)[number];
