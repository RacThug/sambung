import { Link } from "@tanstack/react-router";
import { countNights, type LapsedPayment } from "@sambung/shared";
import { ApiError } from "../../lib/api-client";
import { formatIdr } from "../../lib/money";
import { formatDate } from "../../lib/date";
import { StatusBadge } from "../bookings/booking-badges";
import { Button } from "../../components/ui/button";
import { useLapsedPayments, useMarkHandled } from "./use-lapsed-payments";

/**
 * The paid-but-lapsed payment section of the inbox - `/app/inbox` (#120, ADR-0022).
 * The late-settlement reconciliation surface the webhook (#53, ADR-0018) handles
 * silently: a guest paid AFTER their hold lapsed (swept to `expired`) or the
 * booking was cancelled, so the money is captured but the dates no longer hold.
 *
 * Each item shows enough to act - amount, guest + contact, the stay it was for -
 * a link to the full booking, and a "Mark handled" action. Handling only removes
 * the item from the list; the refund/re-accommodate is a manual, offline act at
 * sandbox (ADR-0011), and nothing here mutates the payment or the booking.
 *
 * A section rather than the whole page since #38: the sync-conflict inbox sits above
 * it, because both are "the system did the safe thing and now needs a human".
 */
export function LapsedPaymentsSection() {
  const query = useLapsedPayments();

  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">
        Payments needing attention
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        These guests paid after their hold expired or the booking was cancelled,
        so the money is captured but the dates are no longer held. Refund or
        re-accommodate them, then mark it handled to clear it from here.
      </p>

      <div className="mt-4">
        <Body query={query} />
      </div>
    </section>
  );
}

function Body({ query }: { query: ReturnType<typeof useLapsedPayments> }) {
  if (query.isError) {
    return (
      <p className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        We couldn’t load this inbox. Please try again.
      </p>
    );
  }
  if (!query.data) {
    return (
      <div className="h-40 animate-pulse rounded-lg border border-border bg-muted/40" />
    );
  }
  if (query.data.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center">
        <h2 className="text-lg font-semibold text-foreground">All clear</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          No payments need attention. Late settlements on an expired or cancelled
          booking show up here so you can refund or re-accommodate the guest.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {query.data.map((item) => (
        <LapsedRow key={item.paymentId} item={item} />
      ))}
    </ul>
  );
}

function LapsedRow({ item }: { item: LapsedPayment }) {
  const handle = useMarkHandled();
  const nights = countNights(item.checkIn, item.checkOut);
  const guest = item.guestName ?? "Guest";
  // A 404 means the item is already gone (handled elsewhere / raced); the list
  // refetch on settle shows the truth, so only surface a real, unexpected error.
  const genericError =
    handle.error instanceof ApiError && handle.error.status !== 404
      ? handle.error.message
      : null;

  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-foreground">
              {formatIdr(item.amountIdr)}
            </span>
            <StatusBadge status={item.bookingStatus} />
          </div>
          <p className="mt-1 text-sm text-foreground">
            {guest}
            {item.guestPhone && (
              <span className="text-muted-foreground"> · {item.guestPhone}</span>
            )}
            {item.guestEmail && (
              <span className="text-muted-foreground"> · {item.guestEmail}</span>
            )}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {item.propertyName} — {item.unitName}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatDate(item.checkIn)} → {formatDate(item.checkOut)} ({nights}{" "}
            night{nights === 1 ? "" : "s"})
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Link
            to="/app/bookings/$bookingId"
            params={{ bookingId: item.bookingId }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            View booking ›
          </Link>
          <Button
            variant="outline"
            onClick={() => handle.mutate(item.paymentId)}
            disabled={handle.isPending}
          >
            {handle.isPending ? "Working…" : "Mark handled"}
          </Button>
        </div>
      </div>

      {genericError && (
        <p className="mt-2 text-sm text-destructive">{genericError}</p>
      )}
    </li>
  );
}
