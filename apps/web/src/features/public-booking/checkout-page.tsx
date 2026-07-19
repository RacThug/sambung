import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
  createBookingRequestSchema,
  countNights,
  depositAmountIdr,
  type CreateBookingRequest,
  type CreateBookingResponse,
  type PaymentSessionResponse,
  type PublicPropertyResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { issuesToFieldErrors } from "../../lib/forms";
import { formatIdr } from "../../lib/money";
import { formatDate } from "../../lib/date";
import { FormField } from "@/components/form-field";
import { describeBlockedNights, describeReason } from "./availability-copy";
import { useQuote } from "./use-availability";

const route = getRouteApi("/p/$slug/book");

/**
 * Checkout - `/p/:slug/book` (page-spec §3.2, #52). The guest details form, then
 * the two-step handoff the funnel exists to cause: create the Hold
 * (`POST /public/bookings`), then open the Provider session
 * (`POST .../pay`) and redirect to Midtrans Snap.
 *
 * The stay arrives in the same typed `?unit&from&to` the picker handed off. It is
 * RE-QUOTED on mount (api-spec §5.3) - the price shown at submit is fresh, and a
 * date taken since the picker is caught here rather than at the write.
 */
export function CheckoutPage() {
  const { slug } = route.useParams();
  const { unit, from, to } = route.useSearch();

  if (!(unit && from && to && to > from)) {
    return (
      <Shell slug={slug} unit={unit} from={from} to={to}>
        <p className="mt-6 text-muted-foreground">
          Choose your dates on the property page to start a booking.
        </p>
      </Shell>
    );
  }
  return <Checkout slug={slug} unitId={unit} from={from} to={to} />;
}

function Checkout({
  slug,
  unitId,
  from,
  to,
}: {
  slug: string;
  unitId: string;
  from: string;
  to: string;
}) {
  // Fresh quote for the exact stay (debounce 0 - immediate). Same cache key as the
  // picker's, so arriving from it is usually a cache hit. The stay is MEMOIZED: a
  // fresh object each render would make useDebounced(ms=0) re-set state every
  // render (an infinite loop), since its effect depends on the value's identity.
  const stay = useMemo(() => ({ from, to }), [from, to]);
  const { query } = useQuote(unitId, stay, 0);
  const quote = query.data;

  // The property carries the Deposit % (ADR-0015). Same cache key as the property
  // page, so arriving from it is a hit. Advisory: a miss just hides the deposit
  // line - it never blocks checkout.
  const property = useQuery({
    queryKey: ["public-property", slug],
    queryFn: () => api.get<PublicPropertyResponse>(`/public/properties/${slug}`),
    staleTime: 60_000,
  }).data;

  const [form, setForm] = useState({
    guestName: "",
    guestPhone: "",
    guestEmail: "",
    guestCount: "2",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Once the Hold exists, the form is done - the booking is made with these
  // details. What remains is the payment handoff, which can be retried against the
  // SAME booking without recreating it (page-spec §3.2: the booking survives).
  const [held, setHeld] = useState<CreateBookingResponse | null>(null);
  const [holdLapsed, setHoldLapsed] = useState(false);

  const createMut = useMutation({
    mutationFn: (body: CreateBookingRequest) =>
      api.post<CreateBookingResponse>("/public/bookings", body),
    onError: (error) => {
      // A server-side 400 (belt-and-braces past the client parse) maps to fields.
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
    },
  });
  const payMut = useMutation({
    mutationFn: (bookingId: string) =>
      api.post<PaymentSessionResponse>(`/public/bookings/${bookingId}/pay`),
  });

  const startPayment = useCallback(
    async (bookingId: string) => {
      const session = await payMut.mutateAsync(bookingId);
      // Leave the SPA for the Provider-hosted page.
      window.location.assign(session.redirectUrl);
    },
    [payMut],
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = createBookingRequestSchema.safeParse({
      unitId,
      checkIn: from,
      checkOut: to,
      guestName: form.guestName,
      guestPhone: form.guestPhone,
      guestEmail: form.guestEmail || undefined,
      guestCount: Number(form.guestCount),
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    try {
      const booking = await createMut.mutateAsync(parsed.data);
      setHeld(booking);
      await startPayment(booking.bookingId);
    } catch {
      // Surfaced below via the mutations' error state; the Hold (if created)
      // stays in `held` for a retry.
    }
  }

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  const nights = countNights(from, to);
  const createConflict = conflictOf(createMut.error);
  // A pay 409 is `booking_not_payable` - the hold lapsed between create and pay.
  const payConflict = conflictOf(payMut.error);
  const payProviderError = payMut.isError && !payConflict;

  // The hold lapsed (countdown hit zero, or the server refused pay for a lapsed
  // hold): the dates are no longer held, so send the guest back to pick again.
  if (holdLapsed || payConflict) {
    return (
      <Shell slug={slug} unit={unitId} from={from} to={to}>
        <div className="mt-6 rounded-lg border border-border bg-card p-5">
          <p className="font-medium text-foreground">Your hold has lapsed</p>
          <p className="mt-1 text-sm text-muted-foreground">
            We only hold dates for a few minutes. Please pick your dates again to
            start over.
          </p>
          <Link
            to="/p/$slug"
            params={{ slug }}
            search={{ unit: unitId, from, to }}
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Pick dates again
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell slug={slug} unit={unitId} from={from} to={to}>
      <StaySummary
        from={from}
        to={to}
        nights={nights}
        quote={quote}
        depositPct={property?.depositPct}
      />

      {/* The dates were taken between the picker and here - the re-quote caught it
          (api-spec §5.3). Offer the way back rather than a dead submit. */}
      {quote && !quote.available && (
        <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          {quote.reasons.map((r) => (
            <p key={r}>{describeReason(r, quote.minStay)}</p>
          ))}
          {quote.blockedRanges.length > 0 && (
            <p className="mt-1">
              Booked: {quote.blockedRanges.map(describeBlockedNights).join(", ")}
            </p>
          )}
          <Link
            to="/p/$slug"
            params={{ slug }}
            search={{ unit: unitId, from, to }}
            className="mt-2 inline-block font-medium underline"
          >
            Pick other dates
          </Link>
        </div>
      )}

      {held ? (
        // The Hold exists; the payment handoff failed (provider error). Retry it
        // against the same booking while the hold lives.
        <PaymentRetry
          held={held}
          pending={payMut.isPending}
          providerError={payProviderError}
          onRetry={() => void startPayment(held.bookingId)}
          onExpire={() => setHoldLapsed(true)}
        />
      ) : (
        <form
          onSubmit={onSubmit}
          noValidate
          className="mt-6 space-y-4 rounded-lg border border-border bg-card p-6"
        >
          <h2 className="font-display text-lg font-semibold text-foreground">
            Your details
          </h2>

          <FormField
            label="Full name"
            value={form.guestName}
            onChange={set("guestName")}
            error={fieldErrors.guestName}
            autoComplete="name"
          />
          <FormField
            label="WhatsApp number"
            value={form.guestPhone}
            onChange={set("guestPhone")}
            error={fieldErrors.guestPhone}
            inputMode="tel"
            autoComplete="tel"
          />
          <FormField
            label="Email (optional)"
            value={form.guestEmail}
            onChange={set("guestEmail")}
            error={fieldErrors.guestEmail}
            inputMode="email"
            autoComplete="email"
          />
          <FormField
            label="Guests"
            type="number"
            inputMode="numeric"
            min={1}
            value={form.guestCount}
            onChange={set("guestCount")}
            error={fieldErrors.guestCount}
          />

          {/* A 409 from the create - dates taken, min-stay, over capacity - is
              machine-readable; the web composes the copy (#82). */}
          {createConflict && (
            <p className="rounded-md bg-warning/10 px-3 py-2 text-sm font-medium text-warning">
              {describeConflict(createConflict)}
            </p>
          )}
          {createMut.isError && !createConflict && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              Something went wrong - please try again.
            </p>
          )}

          <button
            type="submit"
            disabled={
              createMut.isPending ||
              payMut.isPending ||
              (quote && !quote.available)
            }
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {createMut.isPending || payMut.isPending
              ? "Starting secure payment…"
              : "Continue to payment"}
          </button>
        </form>
      )}
    </Shell>
  );
}

/** The Hold exists but payment didn't start (provider error). Retry against the
 * same booking while the hold lives; a lapsed hold sends the guest back. */
function PaymentRetry({
  held,
  pending,
  providerError,
  onRetry,
  onExpire,
}: {
  held: CreateBookingResponse;
  pending: boolean;
  providerError: boolean;
  onRetry: () => void;
  onExpire: () => void;
}) {
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="font-display text-lg font-semibold text-foreground">
        Your dates are held
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        We couldn't reach the payment provider. Your booking is held for{" "}
        <HoldCountdown expiresAt={held.holdExpiresAt} onExpire={onExpire} /> -
        retry the payment before it lapses.
      </p>
      {providerError && (
        <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          Payment couldn't start. Please try again.
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={onRetry}
        className="mt-4 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? "Starting secure payment…" : "Retry payment"}
      </button>
    </div>
  );
}

/** The stay + fresh price (page-spec §3.2 quote summary). When the property takes
 * a partial Deposit, show what's due now vs at the property, so the guest isn't
 * surprised by a smaller charge on the Provider page (ADR-0015). */
function StaySummary({
  from,
  to,
  nights,
  quote,
  depositPct,
}: {
  from: string;
  to: string;
  nights: number;
  quote: { available: boolean; totalPriceIdr: number } | undefined;
  depositPct: number | undefined;
}) {
  const total = quote?.totalPriceIdr;
  // Only a real partial deposit (1-99%) gets a split; 100% or unknown just shows
  // the total. The amount mirrors the server's exactly (shared depositAmountIdr).
  const deposit =
    total != null && depositPct != null && depositPct < 100
      ? depositAmountIdr(total, depositPct)
      : null;

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-5">
      <p className="text-sm text-muted-foreground">Your stay</p>
      <p className="mt-1 text-lg font-medium text-foreground">
        {formatDate(from)} → {formatDate(to)}
      </p>
      <p className="text-sm text-muted-foreground">
        {nights} {nights === 1 ? "night" : "nights"}
      </p>
      {quote?.available && total != null && (
        <p className="mt-3 text-lg font-semibold text-foreground">
          {formatIdr(total)}
        </p>
      )}
      {quote?.available && deposit != null && total != null && (
        <div className="mt-2 rounded-md bg-muted px-3 py-2 text-sm">
          <p className="font-medium text-foreground">
            Deposit due now: {formatIdr(deposit)}{" "}
            <span className="text-muted-foreground">({depositPct}%)</span>
          </p>
          <p className="text-muted-foreground">
            Balance {formatIdr(total - deposit)} due at the property
          </p>
        </div>
      )}
    </div>
  );
}

/** A live mm:ss countdown to `expiresAt`; fires `onExpire` once at zero. */
function HoldCountdown({
  expiresAt,
  onExpire,
}: {
  expiresAt: string;
  onExpire: () => void;
}) {
  const msLeft = () => new Date(expiresAt).getTime() - Date.now();
  const [remaining, setRemaining] = useState(msLeft);

  useEffect(() => {
    const id = setInterval(() => {
      const left = new Date(expiresAt).getTime() - Date.now();
      setRemaining(left);
      if (left <= 0) {
        clearInterval(id);
        onExpire();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt, onExpire]);

  const totalSec = Math.max(0, Math.floor(remaining / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return (
    <span className="font-medium tabular-nums text-foreground">
      {mm}:{String(ss).padStart(2, "0")}
    </span>
  );
}

/** The page frame: back link + heading, shared by every checkout state. */
function Shell({
  slug,
  unit,
  from,
  to,
  children,
}: {
  slug: string;
  unit: string | undefined;
  from: string | undefined;
  to: string | undefined;
  children: React.ReactNode;
}) {
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
      {children}
    </main>
  );
}
