-- Row-Level Security: tenant isolation at the database layer (boss fight #5,
-- defense-in-depth). The app connects as a NON-OWNER role (sambung_app) so these
-- policies apply; migrations/seed run as the owner, which bypasses RLS.
--
-- Policies are fail-closed: the app sets `app.tenant_id` per transaction
-- (set_config). If it is unset, current_setting(...,true) is NULL and every
-- row comparison is false → zero rows. A forgotten WHERE leaks nothing.

-- Tables keyed directly by tenant_id (the tenant row keys on its own id).
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant"
  USING ("id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("id" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "app_user"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "property" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "property"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "unit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "unit"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "channel_connection" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_connection"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "booking" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "booking"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- Child tables without their own tenant_id: scope via their parent.
ALTER TABLE "user_property" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "user_property"
  USING (EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = "user_property"."property_id"
      AND p."tenant_id" = current_setting('app.tenant_id', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = "user_property"."property_id"
      AND p."tenant_id" = current_setting('app.tenant_id', true)::uuid
  ));

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payment"
  USING (EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = "payment"."booking_id"
      AND b."tenant_id" = current_setting('app.tenant_id', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = "payment"."booking_id"
      AND b."tenant_id" = current_setting('app.tenant_id', true)::uuid
  ));

ALTER TABLE "payment_event" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payment_event"
  USING (
    "booking_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "booking" b
      WHERE b."id" = "payment_event"."booking_id"
        AND b."tenant_id" = current_setting('app.tenant_id', true)::uuid
    )
  )
  WITH CHECK (
    "booking_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "booking" b
      WHERE b."id" = "payment_event"."booking_id"
        AND b."tenant_id" = current_setting('app.tenant_id', true)::uuid
    )
  );
