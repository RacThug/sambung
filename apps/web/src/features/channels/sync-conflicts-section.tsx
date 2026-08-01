import { Link } from "@tanstack/react-router";
import { countNights, type SyncConflict } from "@sambung/shared";
import { ApiError } from "../../lib/api-client";
import { formatDate, formatInstant } from "../../lib/date";
import { SourceBadge, StatusBadge } from "../bookings/booking-badges";
import { Button } from "../../components/ui/button";
import { ListState } from "@/components/list-state";
import { useDismissConflict, useSyncConflicts } from "./use-sync-conflicts";

const CHANNEL_LABELS: Record<SyncConflict["channel"], string> = {
  airbnb: "Airbnb",
  booking_com: "Booking.com",
  vrbo: "Vrbo",
};

/**
 * The sync-conflict inbox section on `/app/inbox` (#38, ADR-0027, api-spec §7.5).
 *
 * A conflict is a real-world DOUBLE-SELL: an OTA sold nights Sambung already had
 * booked, so the exclusion constraint refused the import (which is correct - the
 * alternative is two guests at one door). Nothing here can fix that; only the owner
 * can, by deciding in the real world which booking survives. So this section's whole
 * job is to name the clash precisely and put the blocking booking one click away.
 *
 * It shares a page with the paid-but-lapsed payment inbox rather than taking its own
 * nav item: both are "the system did the safe thing and now needs you", and an owner
 * should have one place to check, not two.
 */
export function SyncConflictsSection() {
  const query = useSyncConflicts();

  // This section used to `return null` for loading, empty AND error alike, so a
  // failed read was invisible - on the page whose entire job is surfacing things
  // that need attention, and directly above a sibling that renders all three
  // (divergence D3/D5). It now matches that sibling.
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">
        Calendar conflicts
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        These dates were sold on a channel but are already booked here, so they
        couldn’t be imported. Decide which booking stands, cancel the other, and
        the next sync clears this by itself.
      </p>

      <div className="mt-4">
        <ListState
          query={query}
          errorText="We couldn’t load your calendar conflicts. Please try again."
        >
          {(conflicts) =>
            conflicts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-12 text-center">
                <h3 className="text-lg font-semibold text-foreground">
                  No conflicts
                </h3>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  Your calendars agree. A channel selling nights you have already
                  booked shows up here so you can decide which booking stands.
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {conflicts.map((item) => (
                  <ConflictRow key={item.id} item={item} />
                ))}
              </ul>
            )
          }
        </ListState>
      </div>
    </section>
  );
}

function ConflictRow({ item }: { item: SyncConflict }) {
  const dismiss = useDismissConflict();
  const nights = countNights(item.stay.from, item.stay.to);
  // A 404 means it is already gone (dismissed elsewhere, or resolved by a sync
  // between the render and the click); the refetch shows the truth, so only a real
  // unexpected failure is worth showing.
  const genericError =
    dismiss.error instanceof ApiError && dismiss.error.status !== 404
      ? dismiss.error.message
      : null;

  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">
              {CHANNEL_LABELS[item.channel]} booking couldn’t be imported
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {item.propertyName} - {item.unitName}
          </p>
          <p className="mt-0.5 text-sm text-foreground">
            {formatDate(item.stay.from)} → {formatDate(item.stay.to)} ({nights}{" "}
            night{nights === 1 ? "" : "s"})
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            First seen {formatInstant(item.firstDetectedAt)}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button
            variant="outline"
            onClick={() => dismiss.mutate(item.id)}
            disabled={dismiss.isPending}
          >
            {dismiss.isPending ? "Working…" : "Dismiss"}
          </Button>
        </div>
      </div>

      {/* What is actually in the way. Derived server-side from the same overlap
          test the constraint uses, so this is exactly the set of bookings standing
          between the OTA's stay and a clean import - cancel one of these (if it is
          the one that should lose) and the next sync imports the other side. */}
      {item.blockingBookings.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground">
            Already booked here
          </p>
          <ul className="mt-2 space-y-1.5">
            {item.blockingBookings.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <SourceBadge source={b.source} />
                  <StatusBadge status={b.status} />
                  <span className="text-foreground">
                    {b.guestName ?? "No guest"}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDate(b.checkIn)} → {formatDate(b.checkOut)}
                  </span>
                </span>
                <Link
                  to="/app/bookings/$bookingId"
                  params={{ bookingId: b.id }}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  View booking ›
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {genericError && (
        <p className="mt-2 text-sm text-destructive">{genericError}</p>
      )}
    </li>
  );
}
