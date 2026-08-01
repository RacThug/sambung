import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { isSellable, type PublicPropertyResponse, type PublicUnit } from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { formatIdr } from "../../lib/money";
import { useI18n, type I18n } from "@/i18n/context";
import { VerifiedBadge } from "../properties/verified-badge";
import { PropertyMeta } from "./property-meta";
import { AvailabilityPicker } from "./availability-picker";

const route = getRouteApi("/p/$slug");

/**
 * The public property page (page-spec §3.1, FR-PROP-1, #46) - the page a guest
 * lands on from a shared link, and the only thing standing between a forwarded
 * WhatsApp message and a direct booking.
 *
 * The availability picker and the Book button land with M2 (api #23/#24); the
 * ?from&to search params are already parsed, and deliberately not shown yet -
 * a date field that does nothing is worse than no date field.
 */
export function PropertyPage() {
  const { slug } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate();
  const i18n = useI18n();
  const { t } = i18n;

  // Which unit's picker is open, and its picked stay - all in the URL, so a
  // shared link reproduces the exact view (page-spec §3.1). Merge-update the
  // search so setting dates keeps `unit`, and opening a unit keeps the dates.
  const openUnit = (unit?: string) =>
    void navigate({
      to: "/p/$slug",
      params: { slug },
      search: (prev) => ({ ...prev, unit }),
    });
  const setDates = (dates: { from?: string; to?: string }) =>
    void navigate({
      to: "/p/$slug",
      params: { slug },
      search: (prev) => ({ ...prev, ...dates }),
      // Picking dates shouldn't stack a history entry per click.
      replace: true,
    });

  const { data, isLoading, error } = useQuery({
    queryKey: ["public-property", slug],
    queryFn: () =>
      api.get<PublicPropertyResponse>(`/public/properties/${slug}`),
    // A slug is either an address or it isn't - retrying a 404 just delays it.
    retry: (count, err) =>
      !(err instanceof ApiError && err.status === 404) && count < 1,
  });

  if (isLoading) return <PropertySkeleton />;

  if (error) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-center">
        <title>{missing ? t("property.metaNotFound") : "Sambung"}</title>
        <h1 className="font-display text-2xl font-semibold text-foreground">
          {missing ? t("property.notFoundTitle") : t("property.errorTitle")}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {missing ? t("property.notFoundBody") : t("property.errorBody")}
        </p>
      </main>
    );
  }

  if (!data) return null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PropertyMeta property={data} />

      <Gallery photos={data.photos} name={data.name} />

      <header className="mt-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            {data.name}
          </h1>
          {/* FR-PROP-3: the badge is the licence being on file, nothing else. */}
          {data.verified && <VerifiedBadge label={t("property.verified")} />}
        </div>
        {data.address && <p className="mt-2 text-muted-foreground">{data.address}</p>}
      </header>

      {data.description && (
        <p className="mt-6 whitespace-pre-line leading-relaxed text-foreground">
          {data.description}
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-foreground">
          {t("property.rooms")}
        </h2>
        {data.units.length === 0 ? (
          // Publishable never gates this page (ADR-0004), so "nothing to sell
          // yet" is a state a guest can really land on. Say so plainly rather
          // than rendering an empty heading.
          <p className="mt-2 text-muted-foreground">{t("property.noRooms")}</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {data.units.map((unit) => (
              <li key={unit.id}>
                <UnitCard
                  i18n={i18n}
                  unit={unit}
                  slug={slug}
                  open={search.unit === unit.id}
                  from={search.from}
                  to={search.to}
                  onOpen={() => openUnit(unit.id)}
                  onClose={() => openUnit(undefined)}
                  onDates={setDates}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * One room: the summary (name, capacity, min-stay, price) and its availability
 * picker. The picker opens only when this unit is the one named in `?unit`
 * (page-spec §3.1), so the URL alone decides which is expanded and a deep link
 * lands on the right one.
 *
 * A zero-priced unit is a placeholder, not an offer (api-spec §4.6): it shows
 * "not bookable yet" and no picker or CTA - the sell-gate proper is #48.
 */
function UnitCard({
  i18n,
  unit,
  slug,
  open,
  from,
  to,
  onOpen,
  onClose,
  onDates,
}: {
  i18n: I18n;
  unit: PublicUnit;
  slug: string;
  open: boolean;
  from?: string;
  to?: string;
  onOpen: () => void;
  onClose: () => void;
  onDates: (dates: { from?: string; to?: string }) => void;
}) {
  const { t } = i18n;
  // The shared rule, not a second spelling of it: `isSellable` is what the
  // dashboard's units table and the API's `publishable` derivation both use, and
  // this page inlined `basePriceIdr > 0` instead until the page-spec migration
  // found the two copies.
  const bookable = isSellable(unit);

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <p className="font-medium text-foreground">{unit.name}</p>
          <p className="text-sm text-muted-foreground">
            {t("unit.capacity", { guests: i18n.fmtGuests(unit.maxGuests) })}
            {unit.minStay > 1 &&
              ` · ${t("unit.minStayNote", { nights: i18n.fmtNights(unit.minStay) })}`}
          </p>
        </div>
        <p className="text-right">
          {bookable ? (
            <>
              <span className="font-semibold tabular-nums text-foreground">
                {formatIdr(unit.basePriceIdr)}
              </span>
              <span className="text-sm text-muted-foreground">
                {" "}
                {t("unit.perNight")}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t("unit.priceOnRequest")}
            </span>
          )}
        </p>
      </div>

      {!bookable ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {t("unit.notBookable")}
        </p>
      ) : open ? (
        <>
          <AvailabilityPicker
            unit={unit}
            slug={slug}
            from={from}
            to={to}
            onChange={onDates}
          />
          <button
            type="button"
            onClick={onClose}
            className="mt-3 text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            {t("unit.close")}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="mt-3 inline-flex items-center rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
        >
          {t("unit.checkAvailability")}
        </button>
      )}
    </div>
  );
}

/**
 * Thumbnail columns by count. Tailwind scans source for literal class names, so
 * a template like `grid-cols-${n}` compiles to nothing - this map is what makes
 * the row adapt instead of always reserving four columns.
 */
const THUMB_COLS = ["", "grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4"];
const MAX_THUMBS = 4;

/**
 * The gallery: one hero, then up to four thumbnails.
 *
 * Renders nothing at all when there are no photos. A property with none is
 * reachable on purpose (ADR-0004), so this is a real guest-facing state, and an
 * empty page beats a page with a broken frame in it.
 *
 * The thumbnail row sizes itself to the photos that exist. A fixed four-column
 * grid left two dead columns for the three-photo demo - and owners upload two
 * and three photos constantly, so that gap would have been the common case, not
 * an edge one.
 */
function Gallery({
  photos,
  name,
}: {
  photos: PublicPropertyResponse["photos"];
  name: string;
}) {
  const { t } = useI18n();
  if (photos.length === 0) return null;

  const [hero, ...rest] = photos;
  const thumbs = rest.slice(0, MAX_THUMBS);
  return (
    <div className="space-y-2">
      <img
        src={hero.url}
        // The gallery illustrates the villa the <h1> already names, so the alt
        // says which shot this is rather than repeating the name. Localized
        // (ADR-0024) - alt text is a funnel surface the catalog guard can't see.
        alt={t("property.photoMain", { name })}
        className="aspect-[3/2] w-full rounded-xl object-cover"
        loading="eager"
      />
      {thumbs.length > 0 && (
        <div className={`grid gap-2 ${THUMB_COLS[thumbs.length]}`}>
          {thumbs.map((photo, i) => (
            <img
              key={photo.url}
              src={photo.url}
              alt={t("property.photoN", { name, n: i + 2 })}
              className="aspect-[3/2] w-full rounded-lg object-cover"
              loading="lazy"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PropertySkeleton() {
  return (
    <main className="mx-auto max-w-3xl animate-pulse px-6 py-10">
      <div className="aspect-[4/3] w-full rounded-xl bg-muted" />
      <div className="mt-8 h-8 w-2/3 rounded bg-muted" />
      <div className="mt-3 h-4 w-1/3 rounded bg-muted" />
      <div className="mt-8 space-y-3">
        <div className="h-20 rounded-lg bg-muted" />
        <div className="h-20 rounded-lg bg-muted" />
      </div>
    </main>
  );
}
