import { useState, type ReactNode } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  countNights,
  OCCUPYING_STATUSES,
  type BookingDetail,
  type BookingStatus,
  type CancelBookingResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { formatIdr } from "../../lib/money";
import { formatDate } from "../../lib/date";
import { SourceBadge, StatusBadge } from "./booking-badges";
import { bookingTitle } from "./booking-display";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

const route = getRouteApi("/app/bookings/$bookingId");

const isOccupying = (s: BookingStatus): boolean =>
  (OCCUPYING_STATUSES as readonly string[]).includes(s);

/**
 * Booking detail - `/app/bookings/:id` (page-spec §4.3, #50). Everything about one
 * reservation: guest, dates, source, price, status - and the Cancel action, the
 * universal free-the-dates verb (ADR-0011). Deep-linkable, so it fetches its own
 * row via `GET /bookings/:id` (§5.7) rather than leaning on a warm calendar cache.
 */
export function BookingDetailPage() {
  const { bookingId } = route.useParams();
  const query = useQuery({
    queryKey: ["booking", bookingId],
    queryFn: () => api.get<BookingDetail>(`/bookings/${bookingId}`),
    retry: (count, err) =>
      // A 404 is an answer, not a blip - don't retry it.
      err instanceof ApiError && err.status === 404 ? false : count < 1,
  });

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <section className="mx-auto max-w-2xl">
        <BackLink />
        <p className="mt-6 rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {notFound
            ? "This booking doesn’t exist, or it isn’t yours."
            : "We couldn’t load this booking. Please try again."}
        </p>
      </section>
    );
  }

  if (!query.data) {
    return (
      <section className="mx-auto max-w-2xl">
        <BackLink />
        <div className="mt-6 h-64 animate-pulse rounded-lg border border-border bg-muted/40" />
      </section>
    );
  }

  return <BookingDetail booking={query.data} />;
}

function BackLink() {
  return (
    <Link
      to="/app/calendar"
      className="text-sm text-muted-foreground hover:text-foreground"
    >
      ‹ Back to calendar
    </Link>
  );
}

function BookingDetail({ booking }: { booking: BookingDetail }) {
  const nights = countNights(booking.checkIn, booking.checkOut);
  const title = bookingTitle(booking);

  return (
    <section className="mx-auto max-w-2xl">
      <BackLink />

      <div className="mt-4 rounded-lg border border-border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">{title}</h1>
            <div className="mt-2 flex items-center gap-2">
              <StatusBadge status={booking.status} />
              <SourceBadge source={booking.source} />
            </div>
          </div>
          {booking.status === "pending_payment" && (
            <HoldCountdown holdExpiresAt={booking.holdExpiresAt} />
          )}
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          <Field label="Property">{booking.propertyName}</Field>
          <Field label="Unit">{booking.unitName}</Field>
          <Field label="Check-in">{formatDate(booking.checkIn)}</Field>
          <Field label="Check-out">
            {formatDate(booking.checkOut)}{" "}
            <span className="text-muted-foreground">
              ({nights} night{nights === 1 ? "" : "s"})
            </span>
          </Field>
          <Field label="Total">
            {booking.totalPriceIdr === null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              formatIdr(booking.totalPriceIdr)
            )}
          </Field>
          {booking.guestCount !== null && (
            <Field label="Guests">{booking.guestCount}</Field>
          )}
          {booking.guestPhone && (
            <Field label="Phone">{booking.guestPhone}</Field>
          )}
          {booking.guestEmail && (
            <Field label="Email">{booking.guestEmail}</Field>
          )}
        </dl>

        {isOccupying(booking.status) && <CancelSection booking={booking} />}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** A live hold's remaining minutes (page-spec §4.1/§4.3 edge). Computed once on
 * render - the countdown ticks on the next data refresh, which is enough for an
 * owner glancing at a reservation (no per-second timer needed). */
function HoldCountdown({ holdExpiresAt }: { holdExpiresAt: string | null }) {
  if (!holdExpiresAt) return null;
  const mins = Math.round((Date.parse(holdExpiresAt) - Date.now()) / 60_000);
  return (
    <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
      {mins > 0 ? `Hold expires in ${mins} min` : "Hold expired"}
    </span>
  );
}

function CancelSection({ booking }: { booking: BookingDetail }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const cancel = useMutation({
    mutationFn: () =>
      api.post<CancelBookingResponse>(`/bookings/${booking.id}/cancel`, {}),
    onSuccess: () => {
      setOpen(false);
      // Refresh this booking (now cancelled) and the calendar (dates freed).
      void queryClient.invalidateQueries({ queryKey: ["booking", booking.id] });
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
    onError: (err) => {
      // 409 = someone/something already made it terminal (raced the sweeper, or a
      // double-click). Close the dialog and refetch so the page shows the truth.
      if (err instanceof ApiError && err.status === 409) {
        setOpen(false);
        void queryClient.invalidateQueries({
          queryKey: ["booking", booking.id],
        });
      }
    },
  });

  const isBlock = booking.source === "manual_block";
  const genericError =
    cancel.error instanceof ApiError && cancel.error.status !== 409
      ? cancel.error.message
      : null;

  return (
    <div className="mt-6 border-t border-border pt-4">
      <Button variant="destructive" onClick={() => setOpen(true)}>
        {isBlock ? "Remove block" : "Cancel booking"}
      </Button>
      {genericError && (
        <p className="mt-2 text-sm text-destructive">{genericError}</p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isBlock ? "Remove this block?" : "Cancel this booking?"}
            </DialogTitle>
            <DialogDescription>
              {isBlock
                ? "The dates become bookable again immediately."
                : "The dates become bookable again immediately. Any payment must be refunded manually - Sambung does not refund automatically."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              {cancel.isPending
                ? "Working…"
                : isBlock
                  ? "Yes, remove"
                  : "Yes, cancel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
