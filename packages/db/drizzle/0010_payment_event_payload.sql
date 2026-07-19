-- The verified provider payload, stored WITH the event that records it (#53,
-- boss fight #4). payment_event is the idempotency ledger; keeping each event's
-- raw bytes on its own row gives an audit trail without overloading
-- payment.raw_payload, which holds the open Snap session a pay-retry reads back
-- (ADR-0015). The webhook never touches payment.raw_payload, so a `failure`
-- event can't destroy a session the guest still needs. Nullable: an event type
-- that carries nothing to keep is representable without a sentinel.
ALTER TABLE "payment_event" ADD COLUMN "raw_payload" jsonb;
