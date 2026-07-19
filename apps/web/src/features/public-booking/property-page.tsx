import { getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { PublicPropertyResponse } from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { formatIdr } from "../../lib/money";
import { VerifiedBadge } from "../properties/verified-badge";
import { PropertyMeta } from "./property-meta";

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
        <title>{missing ? "Property not found - Sambung" : "Sambung"}</title>
        <h1 className="font-display text-2xl font-semibold text-foreground">
          {missing ? "This page doesn’t exist" : "Something went wrong"}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {missing
            ? "The link may be mistyped, or the property is no longer listed."
            : "We couldn’t load this property. Please try again."}
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
          {data.verified && <VerifiedBadge />}
        </div>
        {data.address && <p className="mt-2 text-muted-foreground">{data.address}</p>}
      </header>

      {data.description && (
        <p className="mt-6 whitespace-pre-line leading-relaxed text-foreground">
          {data.description}
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-foreground">Rooms</h2>
        {data.units.length === 0 ? (
          // Publishable never gates this page (ADR-0004), so "nothing to sell
          // yet" is a state a guest can really land on. Say so plainly rather
          // than rendering an empty heading.
          <p className="mt-2 text-muted-foreground">
            No rooms are listed yet. Please check back soon.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {data.units.map((unit) => (
              <li
                key={unit.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-border p-4"
              >
                <div>
                  <p className="font-medium text-foreground">{unit.name}</p>
                  <p className="text-sm text-muted-foreground">
                    Up to {unit.maxGuests}{" "}
                    {unit.maxGuests === 1 ? "guest" : "guests"}
                    {unit.minStay > 1 && ` · ${unit.minStay}-night minimum`}
                  </p>
                </div>
                <p className="text-right">
                  {/* A zero price is a placeholder, not an offer (§4.6) - quoting
                      "Rp 0" would read as free. */}
                  {unit.basePriceIdr > 0 ? (
                    <>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatIdr(unit.basePriceIdr)}
                      </span>
                      <span className="text-sm text-muted-foreground"> / night</span>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      Price on request
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
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
  if (photos.length === 0) return null;

  const [hero, ...rest] = photos;
  const thumbs = rest.slice(0, MAX_THUMBS);
  return (
    <div className="space-y-2">
      <img
        src={hero.url}
        // The gallery illustrates the villa the <h1> already names, so the alt
        // says which shot this is rather than repeating the name.
        alt={`${name} - main photo`}
        className="aspect-[3/2] w-full rounded-xl object-cover"
        loading="eager"
      />
      {thumbs.length > 0 && (
        <div className={`grid gap-2 ${THUMB_COLS[thumbs.length]}`}>
          {thumbs.map((photo, i) => (
            <img
              key={photo.url}
              src={photo.url}
              alt={`${name} - photo ${i + 2}`}
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
