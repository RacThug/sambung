import { getRouteApi, Link } from "@tanstack/react-router";

const route = getRouteApi("/booking/$bookingId");

/**
 * Booking landing - `/booking/:id` (page-spec §3.3). Where the Provider returns
 * the guest after Snap. A deliberately THIN placeholder for #52: it exists so the
 * pay redirect lands on a real route, not a dead one.
 *
 * The real confirmation page - reconcile-on-read against the Provider, the wa.me
 * deeplink, the paid amount - is #54. Until then this acknowledges the return; the
 * booking is confirmed by the webhook (#53), so "we're confirming" is the honest
 * state, not "paid".
 */
export function BookingLandingPage() {
  const { bookingId } = route.useParams();

  return (
    <main className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        Thanks - we're confirming your booking
      </h1>
      <p className="mt-3 text-muted-foreground">
        If you completed payment, your booking is being confirmed. You'll get a
        WhatsApp message once it's done.
      </p>
      <p className="mt-6 text-xs text-muted-foreground">Reference: {bookingId}</p>
      <Link
        to="/"
        className="mt-8 inline-block text-sm text-primary hover:underline"
      >
        ← Back home
      </Link>
    </main>
  );
}
