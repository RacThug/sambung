import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { DayPicker, type DateRange } from "react-day-picker";
import type { AvailabilityResponse, PublicUnit } from "@sambung/shared";
import { todayIso } from "../../lib/date";
import { formatIdr } from "../../lib/money";
import {
  blockedMatchers,
  dateToIso,
  initialMonth,
  isoToDate,
  monthWindow,
  pastDisabled,
  rangeFromSearch,
  stayFromRange,
} from "./availability-model";
import {
  describeBlockedNights,
  describeReason,
  describeStay,
} from "./availability-copy";
import { useMonthBlocked, useQuote } from "./use-availability";

/**
 * The availability picker + quote card for one unit (page-spec §3.1, FR-CAL-1/2,
 * #93). react-day-picker gives the calendar its keyboard/focus/ARIA behaviour
 * (ADR-0007: headless underneath, every pixel ours in semantic tokens); the two
 * query modes against `GET availability` (#47) grey the booked nights and quote
 * the selection.
 *
 * The URL (`?from&to`) is the single source of truth for the selection, so a
 * shared link reproduces the exact quote view (AC): `selected` is read from it,
 * `onChange` writes it. The visible month is local view state (not in the URL).
 */
export function AvailabilityPicker({
  unit,
  slug,
  from,
  to,
  onChange,
  /** 0 in tests to skip the debounce; ~300 ms in the app. */
  debounceMs = 300,
}: {
  unit: PublicUnit;
  slug: string;
  from?: string;
  to?: string;
  onChange: (next: { from?: string; to?: string }) => void;
  debounceMs?: number;
}) {
  const today = todayIso();
  const [month, setMonth] = useState<Date>(() => initialMonth(from, today));

  const selected = rangeFromSearch(from, to);
  const stay = stayFromRange(selected);

  const monthQ = useMonthBlocked(unit.id, monthWindow(month));
  const { query: quote, syncing } = useQuote(unit.id, stay, debounceMs);

  const onSelect = (range: DateRange | undefined) =>
    onChange({
      from: range?.from ? dateToIso(range.from) : undefined,
      to: range?.to ? dateToIso(range.to) : undefined,
    });

  return (
    <div className="mt-4 rounded-lg border border-border bg-card p-4">
      <DayPicker
        mode="range"
        month={month}
        onMonthChange={setMonth}
        // Can't book the past, so don't let the guest page into it.
        startMonth={isoToDate(today)}
        selected={selected}
        onSelect={onSelect}
        disabled={pastDisabled(today)}
        modifiers={{ blocked: blockedMatchers(monthQ.data?.blockedRanges ?? []) }}
        modifiersClassNames={{
          blocked: "[&>button]:text-muted-foreground [&>button]:line-through",
        }}
        showOutsideDays={false}
        classNames={CALENDAR_CLASS_NAMES}
      />

      <div className="mt-4 border-t border-border pt-4">
        <QuoteCard
          stay={stay}
          slug={slug}
          unit={unit}
          quote={quote}
          syncing={syncing}
        />
      </div>
    </div>
  );
}

/** The quote card's state machine (page-spec §3.1 States): empty · checking ·
 * available + price · blocked / min_stay · availability-API error (retry
 * inline). The server's verdict is authoritative - the card only renders it. */
function QuoteCard({
  stay,
  slug,
  unit,
  quote,
  syncing,
}: {
  stay: { from: string; to: string } | null;
  slug: string;
  unit: PublicUnit;
  quote: ReturnType<typeof useQuote>["query"];
  syncing: boolean;
}) {
  if (!stay) {
    return (
      <p className="text-sm text-muted-foreground">
        Select your check-in and check-out dates to see availability and price.
      </p>
    );
  }

  // A settled error (not mid-refetch) offers an inline retry; the rest of the
  // page stays usable, so a flaky quote never strands the guest.
  if (quote.isError && !quote.isFetching && !syncing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-destructive">
          Couldn’t check those dates. Please try again.
        </p>
        <button
          type="button"
          onClick={() => void quote.refetch()}
          className="rounded-md border border-input px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          Retry
        </button>
      </div>
    );
  }

  if (syncing || quote.isFetching || !quote.data) {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Checking availability…
      </p>
    );
  }

  return quote.data.available ? (
    <Available res={quote.data} stay={stay} slug={slug} unit={unit} />
  ) : (
    <Unavailable res={quote.data} unit={unit} />
  );
}

function Available({
  res,
  stay,
  slug,
  unit,
}: {
  res: AvailabilityResponse;
  stay: { from: string; to: string };
  slug: string;
  unit: PublicUnit;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-success">Available</p>
        <p className="text-sm text-muted-foreground">
          {describeStay(stay.from, stay.to)} ·{" "}
          <span className="font-semibold text-foreground">
            {formatIdr(res.totalPriceIdr)}
          </span>
        </p>
      </div>
      <Link
        to="/p/$slug/book"
        params={{ slug }}
        search={{ unit: unit.id, from: stay.from, to: stay.to }}
        className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Book these dates
      </Link>
    </div>
  );
}

function Unavailable({
  res,
  unit,
}: {
  res: AvailabilityResponse;
  unit: PublicUnit;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">
        Not available for these dates
      </p>
      <ul className="space-y-1">
        {res.reasons.map((reason) => (
          <li key={reason} className="text-sm text-muted-foreground">
            {describeReason(reason, unit.minStay)}
          </li>
        ))}
      </ul>
      {/* overlap: name the clipped booked nights so the guest can pick around
          them (AC: "overlap highlights the clipped blocked nights"). */}
      {res.blockedRanges.length > 0 && (
        <ul className="space-y-1">
          {res.blockedRanges.map((r) => (
            <li key={r.from} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Booked:</span>{" "}
              {describeBlockedNights(r)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The calendar's look, entirely in semantic tokens (ADR-0007: no default
 * react-day-picker stylesheet is imported). Keys are v9 element parts; `day` is
 * the grid cell, `day_button` the focusable control, `range_*` the selection.
 */
const CALENDAR_CLASS_NAMES = {
  root: "w-fit text-foreground",
  months: "relative flex flex-col",
  month: "flex w-full flex-col gap-3",
  month_caption: "flex h-9 items-center justify-center",
  caption_label: "font-display text-base font-medium text-foreground",
  nav: "pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between",
  button_previous:
    "pointer-events-auto inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30 aria-disabled:opacity-30",
  button_next:
    "pointer-events-auto inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30 aria-disabled:opacity-30",
  chevron: "size-4 fill-current",
  month_grid: "w-full border-collapse",
  weekdays: "flex",
  weekday: "flex-1 pb-1 text-[0.75rem] font-normal text-muted-foreground",
  week: "mt-1 flex w-full",
  day: "relative aspect-square flex-1 p-0 text-center text-sm",
  day_button:
    "mx-auto flex size-9 items-center justify-center rounded-md font-normal transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:text-muted-foreground disabled:opacity-40",
  today: "[&>button]:font-semibold [&>button]:text-primary",
  range_start:
    "rounded-l-md bg-accent [&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground",
  range_end:
    "rounded-r-md bg-accent [&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground",
  range_middle: "bg-accent [&>button]:text-accent-foreground",
  outside: "opacity-40",
  disabled: "opacity-40",
  hidden: "invisible",
};
