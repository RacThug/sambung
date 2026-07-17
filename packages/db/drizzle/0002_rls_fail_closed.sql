-- ▼▼▼ Boss fight #5: make "fail-closed" true (#74) ▼▼▼
-- 0000_init.sql claimed: "If it is unset, current_setting(...,true) is NULL and
-- every row comparison is false → zero rows. A forgotten WHERE leaks nothing."
-- That is false on a pooled connection, and this migration is the fix. (0000 is
-- applied history and stays as written; this file supersedes its comment.)
--
-- set_config(..., is_local => true) reverts at COMMIT to the GUC's RESET value,
-- not to unset. For a custom GUC already set once on that session, the reset
-- value is the EMPTY STRING, not NULL. Measured on PG 16.14:
--
--   fresh session:            current_setting('app.tenant_id', true) IS NULL → t
--   after set_config+commit:  IS NULL → f,  raw value → []      (empty string)
--   ''::uuid                  → ERROR 22P02: invalid input syntax for type uuid
--
-- So a query with no tenant in context returned zero rows on a COLD connection
-- (as documented) but errored 22P02 on a WARM one that had already served a
-- request. Which you got depended on what the pool handed you. That is not a
-- design, and it meant the second layer of defense-in-depth did not behave as
-- advertised: a forgotten WHERE would 500, not return nothing.
--
-- nullif(..., '') maps BOTH the unset (NULL) and reset ('') cases to NULL.
-- `tenant_id = NULL` is NULL, which is not true, so the row is filtered: zero
-- rows on a cold connection and a warm one alike. The comparison stays
-- uuid = uuid, so the tenant_id indexes remain usable - casting tenant_id to
-- text instead would also fail closed, but at the cost of a seq scan on every
-- tenant-scoped query.
--
-- ALTER, not DROP+CREATE: only the predicate changes. FOR/TO clauses keep their
-- defaults (ALL / PUBLIC), exactly as 0000 created them.
ALTER POLICY "tenant_isolation" ON "tenant"
  USING ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "app_user"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "property"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "unit"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "channel_connection"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "booking"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Child tables without their own tenant_id: scoped via their parent. Same fix,
-- one level down - the EXISTS subquery is where the cast lives.
ALTER POLICY "tenant_isolation" ON "user_property"
  USING (EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = "user_property"."property_id"
      AND p."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = "user_property"."property_id"
      AND p."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
  ));--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "payment"
  USING (EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = "payment"."booking_id"
      AND b."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = "payment"."booking_id"
      AND b."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
  ));--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "payment_event"
  USING (
    "booking_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "booking" b
      WHERE b."id" = "payment_event"."booking_id"
        AND b."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "booking_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "booking" b
      WHERE b."id" = "payment_event"."booking_id"
        AND b."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  );
