-- One channel connection per (unit, channel) - api-spec §7.1 (#55). A Unit is one
-- sellable thing (ADR-0001), so its Airbnb calendar is exactly one feed; a second
-- would be the owner wiring the same OTA in twice. THE guard behind the app-level
-- pre-check (which races): mapped to `channel_already_connected` so a lost race and
-- the pre-check refuse identically (api-spec §5.3). No backfill - the seed and any
-- existing rows are already one-per-(unit, channel).
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_unit_channel_uniq" UNIQUE("unit_id","channel");
