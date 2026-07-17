# Deleting inventory never destroys the ledger

Deleting a Property or Unit is refused if **any** booking has ever referenced it - past, cancelled and
expired included, not just future Occupying ones. The service guard produces the count and the message; both
`booking -> unit` foreign keys are `on delete no action` so the database refuses too. Retiring inventory that
has history is a different verb (archive, M2); delete is only for a Unit that was never booked.

Supersedes the "future occupying" rule in api-spec §4.4, which is rewritten to match.

## Why

The original guard counted only `status in ('pending_payment','confirmed') and check_out > current_date`.
Everything else was invisible to it, so `DELETE /properties/:id` returned 204 and silently cascaded away every
past booking, every cancelled booking, and every `payment` row hanging off them - the record of money that
actually changed hands. **The guard protected the calendar, not the ledger**: it asked "will a guest show up?"
when the dangerous question is "did money change hands?".

Cancelling is a domain event with a status; deleting is amnesia. The schema already flinched at this -
`payment_event.booking_id` is `on delete set null` specifically so the idempotency trail survives a booking
that doesn't.

The FKs move because invariant #5's philosophy is that app checks are for UX and the DB is for correctness.
Under `on delete cascade` the database was an accomplice: it actively destroyed the ledger, leaving the
service guard as the only thing between an owner and their history. Now the guard is the good error message
and the FK is the guarantee.

Timing: this landed with #45 (M1) because zero bookings existed yet, so it cost two dropped WHERE clauses and
a migration. After M2 it would have been a change to live data, with no undo.

## Consequences

- **"Cancel them first" is a dead escape hatch** and was removed from api-spec §4.4 / page-spec §4.5.
  Cancelling doesn't remove the row, so a Unit with history is permanently undeletable until archive ships.
  That makes **archive an M2 blocker, not a nice-to-have** - an owner who stops renting a room currently has
  no way to hide it from the public page.
- **Both** `booking -> unit` FKs had to change: the plain `unit_id -> unit.id` and the composite
  `(unit_id, tenant_id) -> unit(id, tenant_id)` from #40. Changing one leaves the other cascading, which
  deletes the booking first and passes the check against zero rows - a guard that looks installed and does
  nothing.
- `no action`, not `restrict`: they differ in *when* they check. `restrict` fires immediately and would break
  deleting a Tenant, which legitimately cascades tenant -> property -> unit -> booking; `no action` defers to
  end-of-statement, sees the bookings are already gone, and passes. Account closure still works.
- `payment.booking_id` stays `on delete cascade`. A booking can now only disappear via Tenant deletion, where
  losing the ledger with the account is the intent.
