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

// ---- Tenancy ------------------------------------------------------------------
export const tenant = pgTable("tenant", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const appUser = pgTable("app_user", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
  email: citext("email").notNull().unique("app_user_email_key"),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("staff"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---- Inventory ------------------------------------------------------------------
export const property = pgTable(
  "property",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Composite-FK target for unit_property_tenant_fk (db-design §4.5, #40).
    unique("property_id_tenant_uniq").on(t.id, t.tenantId),
  ],
);

// Staff scoping: which properties a staff user may touch.
export const userProperty = pgTable(
  "user_property",
  {
    appUserId: uuid("app_user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade", onUpdate: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => property.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.appUserId, t.propertyId] })],
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Composite-FK target for booking/channel_connection tenant FKs (#40).
    unique("unit_id_tenant_uniq").on(t.id, t.tenantId),
    // unit.tenant_id must equal its property's tenant_id - a mismatch is
    // unrepresentable, not an app-code obligation (db-design §4.5).
    foreignKey({
      name: "unit_property_tenant_fk",
      columns: [t.propertyId, t.tenantId],
      foreignColumns: [property.id, property.tenantId],
    }).onDelete("cascade"),
    check("unit_base_price_nonneg", sql`${t.basePriceIdr} >= 0`),
    check("unit_max_guests_positive", sql`${t.maxGuests} > 0`),
    check("unit_min_stay_positive", sql`${t.minStay} >= 1`),
  ],
);

// ---- Channels ------------------------------------------------------------------
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
    unitId: uuid("unit_id")
      .notNull()
      .references(() => unit.id, { onDelete: "cascade", onUpdate: "cascade" }),
    source: bookingSource("source").notNull(),
    status: bookingStatus("status").notNull(),
    checkIn: date("check_in", { mode: "string" }).notNull(),
    checkOut: date("check_out", { mode: "string" }).notNull(),
    guestName: text("guest_name"), // null for manual_block / some imports
    guestContact: text("guest_contact"),
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
    foreignKey({
      name: "booking_unit_tenant_fk",
      columns: [t.unitId, t.tenantId],
      foreignColumns: [unit.id, unit.tenantId],
    }).onDelete("cascade"),
    check("booking_stay_nonempty", sql`${t.checkOut} > ${t.checkIn}`),
    check(
      "booking_total_price_nonneg",
      sql`${t.totalPriceIdr} is null or ${t.totalPriceIdr} >= 0`,
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
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [
    unique("payment_event_provider_event_uniq").on(t.provider, t.providerEventId),
  ],
);

// ---- Row types ------------------------------------------------------------------
export type Tenant = typeof tenant.$inferSelect;
export type AppUser = typeof appUser.$inferSelect;
export type Property = typeof property.$inferSelect;
export type Unit = typeof unit.$inferSelect;
export type ChannelConnection = typeof channelConnection.$inferSelect;
export type Booking = typeof booking.$inferSelect;
export type Payment = typeof payment.$inferSelect;
export type PaymentEvent = typeof paymentEvent.$inferSelect;
export type UserRole = (typeof userRole.enumValues)[number];
export type BookingSource = (typeof bookingSource.enumValues)[number];
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
