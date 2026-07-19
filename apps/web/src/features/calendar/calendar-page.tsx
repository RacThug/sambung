import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { CalendarGrid } from "./calendar-grid";
import {
  addDays,
  buildCalendar,
  currentMonthWindow,
  isEmptyCalendar,
  shiftMonth,
} from "./calendar-model";
import { SourceLegend } from "./source-legend";
import { useCalendarData } from "./use-calendar";

const route = getRouteApi("/app/calendar");

/** Today as a local `YYYY-MM-DD` (the owner's calendar day, not UTC) - the anchor
 * for the default month and the Today button. */
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** "March 2027" for a whole calendar month; a "1 Mar – 14 Mar 2027" range for a
 * pasted free window. */
function windowLabel(from: string, to: string): string {
  const month = currentMonthWindow(from);
  if (from === month.from && to === month.to) {
    return new Date(`${from}T00:00:00Z`).toLocaleDateString("en", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return `${fmtDay(from)} – ${fmtDay(addDays(to, -1))} ${from.slice(0, 4)}`;
}

/**
 * The unified calendar - the dashboard home (page-spec §4.1, #49). One row per
 * Unit across every Property, occupying bookings drawn as bars coloured by source,
 * holds hatched. Read-only here; clicking through to a booking (a detail drawer)
 * and creating a manual block land in #50. Composed on the client from three
 * neutral reads (ADR-0010).
 */
export function CalendarPage() {
  const search = route.useSearch();
  const navigate = useNavigate();

  const window =
    search.from && search.to
      ? { from: search.from, to: search.to }
      : currentMonthWindow(todayIso());
  const propertyId = search.propertyId;

  const { properties, units, bookings } = useCalendarData(window, propertyId);

  const go = (next: {
    from?: string;
    to?: string;
    propertyId?: string;
  }) => void navigate({ to: "/app/calendar", search: next });

  const stepMonth = (delta: number) => {
    const w = shiftMonth(window, delta);
    go({ from: w.from, to: w.to, propertyId });
  };

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">
            {windowLabel(window.from, window.to)}
          </h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => stepMonth(-1)}
              className="rounded-md border border-input px-2 py-1 text-sm text-foreground hover:bg-muted"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => go({ propertyId })}
              className="rounded-md border border-input px-2 py-1 text-sm font-medium text-foreground hover:bg-muted"
            >
              Today
            </button>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => stepMonth(1)}
              className="rounded-md border border-input px-2 py-1 text-sm text-foreground hover:bg-muted"
            >
              ›
            </button>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Property
          <select
            value={propertyId ?? ""}
            onChange={(e) =>
              go({
                from: window.from,
                to: window.to,
                propertyId: e.target.value || undefined,
              })
            }
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All properties</option>
            {(properties.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mb-3">
        <SourceLegend />
      </div>

      <CalendarBody
        window={window}
        propertyId={propertyId}
        properties={properties}
        units={units}
        bookings={bookings}
      />
    </section>
  );
}

function CalendarBody({
  window,
  propertyId,
  properties,
  units,
  bookings,
}: {
  window: { from: string; to: string };
  propertyId?: string;
  properties: ReturnType<typeof useCalendarData>["properties"];
  units: ReturnType<typeof useCalendarData>["units"];
  bookings: ReturnType<typeof useCalendarData>["bookings"];
}) {
  if (properties.isError || units.isError || bookings.isError) {
    return (
      <p className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        We couldn’t load the calendar. Please try again.
      </p>
    );
  }

  if (!properties.data || !units.data || !bookings.data) {
    return (
      <div className="h-64 animate-pulse rounded-lg border border-border bg-muted/40" />
    );
  }

  const groups = buildCalendar({
    properties: properties.data,
    units: units.data,
    bookings: bookings.data,
    propertyId,
  });

  if (isEmptyCalendar(groups)) {
    return (
      <EmptyState
        hasProperties={properties.data.length > 0}
        hasUnits={units.data.length > 0}
      />
    );
  }

  return <CalendarGrid groups={groups} window={window} />;
}

function EmptyState({
  hasProperties,
  hasUnits,
}: {
  hasProperties: boolean;
  hasUnits: boolean;
}) {
  // Three flavours (page-spec §4.1): the true onboarding CTA when there is no
  // inventory at all, a nudge to add a Unit, or (rarely) an all-archived tenant.
  const { title, body, cta } = !hasProperties
    ? {
        title: "Add your first property",
        body: "List a villa or guesthouse, then add its rooms to see them here.",
        cta: "Add a property",
      }
    : !hasUnits
      ? {
          title: "Add a unit",
          body: "Your property needs at least one bookable room before the calendar has anything to show.",
          cta: "Add a unit",
        }
      : {
          title: "No active units",
          body: "Every unit is archived. Unarchive one to see its calendar again.",
          cta: "Manage properties",
        };

  return (
    <div className="rounded-lg border border-dashed border-border p-12 text-center">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        {body}
      </p>
      <Link
        to="/app/properties"
        className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        {cta}
      </Link>
    </div>
  );
}
