import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { BookingConfirmationResponse } from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { formatIdr } from "../../lib/money";
import { useI18n, type I18n } from "@/i18n/context";

const route = getRouteApi("/booking/$bookingId");

/**
 * Confirmation - `/booking/:id` (page-spec §3.3, #54). Where the Provider returns
 * the guest after Snap, and the link in their email. Live status that RECONCILES
 * on the server (risk R3): a lost webhook still confirms here. This page just
 * polls the read - the reconcile is the API's job (ADR-0020).
 *
 * Polls every 5s WHILE pending and stops on any terminal status, so a confirmation
 * appears with no manual refresh. States: confirmed / pending+spinner / expired /
 * cancelled / not-found. All copy is localized (ADR-0024); dates follow the
 * visitor's locale.
 */
export function ConfirmationPage() {
  const { bookingId } = route.useParams();
  const i18n = useI18n();
  const { t } = i18n;
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
          title={notFound ? t("confirm.notFoundTitle") : t("confirm.errorTitle")}
          body={notFound ? t("confirm.notFoundBody") : t("confirm.errorBody")}
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
      <Booking i18n={i18n} booking={query.data} />
    </Shell>
  );
}

function Booking({
  i18n,
  booking,
}: {
  i18n: I18n;
  booking: BookingConfirmationResponse;
}) {
  const { t } = i18n;
  switch (booking.status) {
    case "confirmed":
      return <Confirmed i18n={i18n} booking={booking} />;
    case "pending_payment":
      return <Pending i18n={i18n} />;
    case "expired":
      return (
        <StateCard
          title={t("confirm.expiredTitle")}
          body={t("confirm.expiredBody")}
        />
      );
    case "cancelled":
      return (
        <StateCard
          title={t("confirm.cancelledTitle")}
          body={t("confirm.cancelledBody")}
        />
      );
  }
}

/** The party view (page-spec §3.3): dates, property, amount paid, wa.me button. */
function Confirmed({
  i18n,
  booking,
}: {
  i18n: I18n;
  booking: BookingConfirmationResponse;
}) {
  const { t } = i18n;
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
          {t("confirm.allSet")}
        </h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("confirm.confirmedBody")}
      </p>

      <dl className="mt-6 space-y-3 border-t border-border pt-4 text-sm">
        <Row label={t("confirm.stay")}>
          {booking.propertyName} - {booking.unitName}
        </Row>
        <Row label={t("confirm.checkIn")}>{i18n.fmtDate(booking.checkIn)}</Row>
        <Row label={t("confirm.checkOut")}>{i18n.fmtDate(booking.checkOut)}</Row>
        <Row label={t("confirm.paidOnline")}>
          {formatIdr(booking.amountPaidIdr)}
        </Row>
        {/* The server states the balance now (api-spec §6.3) - the page used to
            subtract two fields itself, which put money arithmetic in the browser
            and a second opinion about what "paid" means. */}
        {booking.balanceIdr !== null && booking.balanceIdr > 0 && (
          <Row label={t("confirm.balanceAtProperty")}>
            {formatIdr(booking.balanceIdr)}
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
          {t("confirm.sendWhatsapp")}
        </a>
      )}
    </div>
  );
}

/** Still pending: spinner + reassurance that the page updates itself. */
function Pending({ i18n }: { i18n: I18n }) {
  const { t } = i18n;
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6 text-center">
      <div
        role="status"
        aria-label={t("confirm.pendingAria")}
        className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary"
      />
      <h2 className="mt-4 font-display text-lg font-semibold text-foreground">
        {t("confirm.pendingTitle")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("confirm.pendingBody")}
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
  const { t } = useI18n();
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6 text-center">
      <h2 className="font-display text-lg font-semibold text-foreground">
        {title}
      </h2>
      <p className="mt-2 text-muted-foreground">{body}</p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm text-primary hover:underline"
      >
        {t("confirm.backHome")}
      </Link>
    </div>
  );
}

/** The page frame, shared by every state. */
function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        {t("confirm.title")}
      </h1>
      {children}
    </main>
  );
}
