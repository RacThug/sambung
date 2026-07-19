import { getRouteApi, Link } from "@tanstack/react-router";
import { countNights } from "@sambung/shared";
import { formatDate } from "../../lib/date";

const route = getRouteApi("/p/$slug/book");

/**
 * Checkout - `/p/:slug/book` (page-spec §3.2). A deliberately THIN placeholder:
 * #93 only needs the picker's "Book" CTA to hand off the quoted range here
 * (`?unit&from&to`), so this confirms the stay it received. The guest-details
 * form + payment session (Midtrans sandbox) are a separate M2/M3 issue that
 * replaces this component; it exists now so the CTA lands somewhere real rather
 * than a dead route.
 */
export function CheckoutPage() {
  const { slug } = route.useParams();
  const { unit, from, to } = route.useSearch();

  const hasStay = Boolean(unit && from && to && to > from);

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <Link
        to="/p/$slug"
        params={{ slug }}
        search={{ unit, from, to }}
        className="text-sm text-primary hover:underline"
      >
        ← Back to the property
      </Link>

      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground">
        Request to book
      </h1>

      {hasStay ? (
        <div className="mt-6 rounded-lg border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">Your stay</p>
          <p className="mt-1 text-lg font-medium text-foreground">
            {formatDate(from!)} → {formatDate(to!)}
          </p>
          <p className="text-sm text-muted-foreground">
            {countNights(from!, to!)}{" "}
            {countNights(from!, to!) === 1 ? "night" : "nights"}
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            Guest details and secure payment are coming next.
          </p>
        </div>
      ) : (
        <p className="mt-6 text-muted-foreground">
          Choose your dates on the property page to start a booking.
        </p>
      )}
    </main>
  );
}
