import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { BookingConfirmationResponse } from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { formatIdr } from "../../lib/money";
import { formatDate } from "../../lib/date";

const route = getRouteApi("/booking/$bookingId");

/**
 * Confirmation - `/booking/:id` (page-spec §3.3, #54). Where the Provider returns
 * the guest after Snap, and the link in their email. Live status that RECONCILES
 * on the server (risk R3): a lost webhook still confirms here. This page just
 * polls the read - the reconcile is the API's job (ADR-0020).
 *
 * Polls every 5s WHILE pending and stops on any terminal status, so a confirmation
 * appears with no manual refresh. States: confirmed / pending+spinner / expired /
 * cancelled / not-found.
 */
export function ConfirmationPage() {
  const { bookingId } = route.useParams();
  const query = useQuery({
    queryKey: ["booking-confirmation", bookingId],
    queryFn: () =>
      api.get<BookingConfirmationResponse>(`/public/bookings/${bookingId}`),
    // Keep polling while the booking is still pending; stop the moment it reaches
    // a terminal status (page-spec §3.3). A lost webhook is reconciled server-side
    // on each of these reads, so the flip to confirmed needs no user action.
    refetchInterval: (q) =>
      q.state.data?.status === "pending_payment" ? 5000 : false,
    // A 404 is an answer (unknown/forwarded-wrong id), not a blip - don't retry it.
    retry: (count, err) =>
      err instanceof ApiError && err.status === 404 ? false : count < 1,
  });

  if (query.isError) {
    const notFound =
      query.error instanceof ApiError && query.error.status === 404;
    return (
      <Shell>
        <StateCard
          title={notFound ? "Booking not found" : "Something went wrong"}
          body={
            notFound
              ? "We couldn't find this booking. Check the link, or contact your host."
              : "We couldn't load your booking just now. Please try again."
          }
        />
      </Shell>
    );
  }

  if (!query.data) {
    return (
      <Shell>
        <div className="mt-6 h-56 animate-pulse rounded-lg border border-border bg-muted/40" />
      </Shell>
    );
  }

  return (
    <Shell>
      <Booking booking={query.data} />
    </Shell>
  );
}

function Booking({ booking }: { booking: BookingConfirmationResponse }) {
  switch (booking.status) {
    case "confirmed":
      return <Confirmed booking={booking} />;
    case "pending_payment":
      return <Pending />;
    case "expired":
      return (
        <StateCard
          title="Your hold has lapsed"
          body="We only hold dates for a few minutes, and this hold has expired. Nothing was charged - please start a new booking."
        />
      );
    case "cancelled":
      return (
        <StateCard
          title="This booking was cancelled"
          body="If you think this is a mistake, contact your host."
        />
      );
  }
}

/** The party view (page-spec §3.3): dates, property, amount paid, wa.me button. */
function Confirmed({ booking }: { booking: BookingConfirmationResponse }) {
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary"
        >
          ✓
        </span>
        <h2 className="font-display text-xl font-semibold text-foreground">
          You're all set
        </h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Your booking is confirmed. A copy is on its way to your email.
      </p>

      <dl className="mt-6 space-y-3 border-t border-border pt-4 text-sm">
        <Row label="Stay">
          {booking.propertyName} - {booking.unitName}
        </Row>
        <Row label="Check-in">{formatDate(booking.checkIn)}</Row>
        <Row label="Check-out">{formatDate(booking.checkOut)}</Row>
        <Row label="Paid online">{formatIdr(booking.amountPaidIdr)}</Row>
        {booking.totalPriceIdr !== null &&
          booking.totalPriceIdr > booking.amountPaidIdr && (
            <Row label="Balance at the property">
              {formatIdr(booking.totalPriceIdr - booking.amountPaidIdr)}
            </Row>
          )}
      </dl>

      {booking.waLink && (
        <a
          href={booking.waLink}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 flex w-full items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground"
        >
          Send WhatsApp confirmation
        </a>
      )}
    </div>
  );
}

/** Still pending: spinner + reassurance that the page updates itself. */
function Pending() {
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6 text-center">
      <div
        role="status"
        aria-label="Confirming your payment"
        className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary"
      />
      <h2 className="mt-4 font-display text-lg font-semibold text-foreground">
        Confirming your payment…
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        This can take a moment. This page updates automatically - no need to
        refresh.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{children}</dd>
    </div>
  );
}

function StateCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6 text-center">
      <h2 className="font-display text-lg font-semibold text-foreground">
        {title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm text-primary hover:underline"
      >
        ← Back home
      </Link>
    </div>
  );
}

/** The page frame, shared by every state. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        Your booking
      </h1>
      {children}
    </main>
  );
}
