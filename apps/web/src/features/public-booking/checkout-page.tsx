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
import { conflictOf } from "../../lib/conflict";
import { issuesToFieldErrors } from "../../lib/forms";
import { formatIdr } from "../../lib/money";
import { FormField } from "@/components/form-field";
import { useI18n, type I18n } from "@/i18n/context";
import {
  describeBlockedNights,
  describeReason,
  describeRefusal,
} from "./availability-copy";
// `phone` is imported for its TYPE only (erased at build). Its RUNTIME - the
// country list and E.164 resolver - pulls in libphonenumber-js (~25 KB gzipped),
// so it is loaded lazily via dynamic `import()` at the checkout phone step (#125,
// ADR-0023). That keeps libphonenumber out of the property and confirmation pages
// entirely, and out of the checkout chunk's initial paint.
import type { CountryCode } from "./phone";
import { useQuote } from "./use-availability";

type PhoneKit = typeof import("./phone");

/** Indonesia by default - this is a Bali direct-booking product. Kept in sync
 * with phone.ts's DEFAULT_COUNTRY (a plain literal, so referencing it does not
 * force libphonenumber into this chunk's static graph). */
const DEFAULT_COUNTRY = "ID" satisfies CountryCode;

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
  const { t } = useI18n();

  if (!(unit && from && to && to > from)) {
    return (
      <Shell slug={slug} unit={unit} from={from} to={to}>
        <p className="mt-6 text-muted-foreground">{t("checkout.chooseDates")}</p>
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
  const i18n = useI18n();
  const { t } = i18n;
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
    // Phone is captured as (country, national number) and assembled into E.164 at
    // submit (#54) - a bare national number is ambiguous, so the country resolves
    // it. Default Indonesia, this being a Bali product.
    guestPhoneCountry: DEFAULT_COUNTRY as CountryCode,
    guestPhoneNational: "",
    guestEmail: "",
    guestCount: "2",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Once the Hold exists, the form is done - the booking is made with these
  // details. What remains is the payment handoff, which can be retried against the
  // SAME booking without recreating it (page-spec §3.2: the booking survives).
  const [held, setHeld] = useState<CreateBookingResponse | null>(null);
  const [holdLapsed, setHoldLapsed] = useState(false);

  // The phone kit (country list + E.164 resolver) carries libphonenumber-js, so
  // it is fetched as its own chunk when the checkout form mounts (#125) rather
  // than shipped with the property/confirmation pages. Kick it off on mount so the
  // country <select> populates promptly; until it resolves the select shows a
  // disabled "Loading…" placeholder (the rest of the form is usable meanwhile).
  //
  // A code-split chunk can fail to fetch (a network blip mid-funnel). We surface
  // that as a Retry affordance instead of a stuck "Loading…" + an unhandled
  // rejection at submit (#125 review). `loadPhoneKit` is the one loader - the
  // mount effect, the Retry button, and the submit path all call it; the browser
  // dedupes the `import()`, and it returns the module so submit can use it.
  const [phoneKit, setPhoneKit] = useState<PhoneKit | null>(null);
  const [phoneFailed, setPhoneFailed] = useState(false);
  const loadPhoneKit = useCallback(async (): Promise<PhoneKit | null> => {
    setPhoneFailed(false);
    try {
      const mod = await import("./phone");
      setPhoneKit(mod);
      return mod;
    } catch {
      setPhoneFailed(true);
      return null;
    }
  }, []);
  useEffect(() => {
    void loadPhoneKit();
  }, [loadPhoneKit]);

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
    // Assemble E.164 from the selected country + national number (#54). A clear
    // inline error, never a silent transform - client validation is UX; the shared
    // schema below (and the server) enforce E.164 as correctness. The resolver is
    // in the lazily-loaded phone kit; if it isn't in yet we await it (the deduped
    // `import()` the mount effect started), and if that fetch failed we stop with
    // the Retry affordance shown rather than throw an unhandled rejection (#125).
    const kit = phoneKit ?? (await loadPhoneKit());
    if (!kit) return;
    const guestPhone = kit.toE164(form.guestPhoneNational, form.guestPhoneCountry);
    if (!guestPhone) {
      setFieldErrors({ guestPhone: t("checkout.invalidPhone") });
      return;
    }
    const parsed = createBookingRequestSchema.safeParse({
      unitId,
      checkIn: from,
      checkOut: to,
      guestName: form.guestName,
      guestPhone,
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
          <p className="font-medium text-foreground">
            {t("checkout.holdLapsedTitle")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("checkout.holdLapsedBody")}
          </p>
          <Link
            to="/p/$slug"
            params={{ slug }}
            search={{ unit: unitId, from, to }}
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {t("checkout.pickDatesAgain")}
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell slug={slug} unit={unitId} from={from} to={to}>
      <StaySummary
        i18n={i18n}
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
            <p key={r}>{describeReason(i18n, r, quote.minStay)}</p>
          ))}
          {quote.blockedRanges.length > 0 && (
            <p className="mt-1">
              {t("picker.bookedLabel")}{" "}
              {quote.blockedRanges
                .map((r) => describeBlockedNights(i18n, r))
                .join(", ")}
            </p>
          )}
          <Link
            to="/p/$slug"
            params={{ slug }}
            search={{ unit: unitId, from, to }}
            className="mt-2 inline-block font-medium underline"
          >
            {t("checkout.pickOtherDates")}
          </Link>
        </div>
      )}

      {held ? (
        // The Hold exists; the payment handoff failed (provider error). Retry it
        // against the same booking while the hold lives.
        <PaymentRetry
          i18n={i18n}
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
            {t("checkout.yourDetails")}
          </h2>

          <FormField
            label={t("checkout.fullName")}
            value={form.guestName}
            onChange={set("guestName")}
            error={fieldErrors.guestName}
            autoComplete="name"
          />
          <FormField label={t("checkout.whatsapp")} error={fieldErrors.guestPhone}>
            {(control) => (
              <div className="mt-1 flex gap-2">
                <select
                  aria-label={t("checkout.country")}
                  value={form.guestPhoneCountry}
                  disabled={!phoneKit}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      guestPhoneCountry: e.target.value as CountryCode,
                    }))
                  }
                  className="max-w-[9rem] shrink-0 rounded-md border border-input bg-background px-2 py-2 text-sm disabled:opacity-70"
                >
                  {phoneKit ? (
                    phoneKit.COUNTRY_OPTIONS.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} (+{c.callingCode})
                      </option>
                    ))
                  ) : (
                    // Placeholder while the phone kit loads (or if it failed to);
                    // value matches the selected country so the controlled
                    // <select> stays valid. The Retry affordance sits below.
                    <option value={form.guestPhoneCountry}>
                      {phoneFailed ? t("checkout.unavailable") : t("checkout.loading")}
                    </option>
                  )}
                </select>
                <input
                  {...control}
                  value={form.guestPhoneNational}
                  onChange={set("guestPhoneNational")}
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="812 3456 7890"
                  className="w-full rounded-md border border-input px-3 py-2"
                />
              </div>
            )}
          </FormField>
          {/* The country-list chunk failed to fetch (#125 review): let the guest
              retry rather than stranding them on a disabled "Loading…" select. */}
          {phoneFailed && (
            <p className="text-sm text-muted-foreground" role="alert">
              {t("checkout.countryLoadFailed")}{" "}
              <button
                type="button"
                onClick={() => void loadPhoneKit()}
                className="font-medium text-primary underline"
              >
                {t("picker.retry")}
              </button>
            </p>
          )}
          <FormField
            label={t("checkout.emailOptional")}
            value={form.guestEmail}
            onChange={set("guestEmail")}
            error={fieldErrors.guestEmail}
            inputMode="email"
            autoComplete="email"
          />
          <FormField
            label={t("checkout.guests")}
            type="number"
            inputMode="numeric"
            min={1}
            value={form.guestCount}
            onChange={set("guestCount")}
            error={fieldErrors.guestCount}
          />

          {/* A 409 from the create - dates taken, min-stay, over capacity - is
              machine-readable; the web composes its OWN localized copy (#82,
              ADR-0024) from the reasons, never server prose. */}
          {createConflict && (
            <p className="rounded-md bg-warning/10 px-3 py-2 text-sm font-medium text-warning">
              {createConflict.code === "dates_unavailable"
                ? describeRefusal(i18n, createConflict.reasons)
                : t("checkout.genericError")}
            </p>
          )}
          {createMut.isError && !createConflict && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              {t("checkout.genericError")}
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
              ? t("checkout.startingPayment")
              : t("checkout.continueToPayment")}
          </button>
        </form>
      )}
    </Shell>
  );
}

/** The Hold exists but payment didn't start (provider error). Retry against the
 * same booking while the hold lives; a lapsed hold sends the guest back. */
function PaymentRetry({
  i18n,
  held,
  pending,
  providerError,
  onRetry,
  onExpire,
}: {
  i18n: I18n;
  held: CreateBookingResponse;
  pending: boolean;
  providerError: boolean;
  onRetry: () => void;
  onExpire: () => void;
}) {
  const { t } = i18n;
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="font-display text-lg font-semibold text-foreground">
        {t("checkout.heldTitle")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("checkout.heldBodyPre")}{" "}
        <HoldCountdown expiresAt={held.holdExpiresAt} onExpire={onExpire} />{" "}
        {t("checkout.heldBodyPost")}
      </p>
      {providerError && (
        <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {t("checkout.paymentCouldntStart")}
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={onRetry}
        className="mt-4 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? t("checkout.startingPayment") : t("checkout.retryPayment")}
      </button>
    </div>
  );
}

/** The stay + fresh price (page-spec §3.2 quote summary). When the property takes
 * a partial Deposit, show what's due now vs at the property, so the guest isn't
 * surprised by a smaller charge on the Provider page (ADR-0015). */
function StaySummary({
  i18n,
  from,
  to,
  nights,
  quote,
  depositPct,
}: {
  i18n: I18n;
  from: string;
  to: string;
  nights: number;
  quote: { available: boolean; totalPriceIdr: number } | undefined;
  depositPct: number | undefined;
}) {
  const { t } = i18n;
  const total = quote?.totalPriceIdr;
  // Only a real partial deposit (1-99%) gets a split; 100% or unknown just shows
  // the total. The amount mirrors the server's exactly (shared depositAmountIdr).
  const deposit =
    total != null && depositPct != null && depositPct < 100
      ? depositAmountIdr(total, depositPct)
      : null;

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-5">
      <p className="text-sm text-muted-foreground">{t("checkout.yourStay")}</p>
      <p className="mt-1 text-lg font-medium text-foreground">
        {i18n.fmtDate(from)} → {i18n.fmtDate(to)}
      </p>
      <p className="text-sm text-muted-foreground">{i18n.fmtNights(nights)}</p>
      {quote?.available && total != null && (
        <p className="mt-3 text-lg font-semibold text-foreground">
          {formatIdr(total)}
        </p>
      )}
      {quote?.available && deposit != null && total != null && (
        <div className="mt-2 rounded-md bg-muted px-3 py-2 text-sm">
          <p className="font-medium text-foreground">
            {t("checkout.depositDueNow", { amount: formatIdr(deposit) })}{" "}
            <span className="text-muted-foreground">({depositPct}%)</span>
          </p>
          <p className="text-muted-foreground">
            {t("checkout.balanceAtProperty", {
              amount: formatIdr(total - deposit),
            })}
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
  const { t } = useI18n();
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <Link
        to="/p/$slug"
        params={{ slug }}
        search={{ unit, from, to }}
        className="text-sm text-primary hover:underline"
      >
        {t("checkout.back")}
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground">
        {t("checkout.title")}
      </h1>
      {children}
    </main>
  );
}
