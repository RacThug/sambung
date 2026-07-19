import { Link } from "@tanstack/react-router";
import { countNights, type BookingRow } from "@sambung/shared";
import {
  SOURCE_META,
  barSpan,
  windowDays,
  type BarSpan,
  type CalendarGroup,
  type CalendarRow,
  type Day,
} from "./calendar-model";
import type { CreateSeed } from "./manual-booking-dialog";

// Fixed geometry (px). The timeline scrolls horizontally when the window is wide
// (a quarter ~= 90 columns); the label column stays put. Desktop-first, owner-
// facing. Row heights are shared by both columns so they align line-for-line.
const DAY_W = 40;
const ROW_H = 44;
const PROP_H = 32;
const HEAD_H = 44;
const LABEL_W = 184;

const WEEKDAY = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

type Window = { from: string; to: string };

export function CalendarGrid({
  groups,
  window,
  onCreateAt,
}: {
  groups: CalendarGroup[];
  window: Window;
  /** Owner clicked an empty day on an (active) Unit row - open the create dialog
   * seeded with that Unit + date (page-spec §4.1). */
  onCreateAt: (seed: CreateSeed) => void;
}) {
  const days = windowDays(window.from, window.to);
  const trackWidth = days.length * DAY_W;

  return (
    <div className="flex overflow-hidden rounded-lg border border-border bg-card">
      {/* Left: unit labels, grouped by property. Does not scroll horizontally. */}
      <div className="shrink-0 border-r border-border" style={{ width: LABEL_W }}>
        <div style={{ height: HEAD_H }} className="border-b border-border" />
        {groups.map((group) => (
          <div key={group.property.id}>
            <div
              style={{ height: PROP_H }}
              className="flex items-center border-b border-border bg-muted px-3 text-xs font-semibold text-muted-foreground"
            >
              <span className="truncate">{group.property.name}</span>
            </div>
            {group.rows.map((row) => (
              <div
                key={row.unit.id}
                style={{ height: ROW_H }}
                className="flex items-center gap-1.5 border-b border-border px-3"
              >
                <span
                  className={`truncate text-sm ${row.archived ? "text-muted-foreground" : "text-foreground"}`}
                >
                  {row.unit.name}
                </span>
                {row.archived && (
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Archived
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Right: the day timeline. Scrolls horizontally for wide windows. */}
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div style={{ width: trackWidth }}>
          <div className="flex border-b border-border" style={{ height: HEAD_H }}>
            {days.map((day) => (
              <DayHeader key={day.date} day={day} />
            ))}
          </div>
          {groups.map((group) => (
            <div key={group.property.id}>
              <div
                className="border-b border-border bg-muted"
                style={{ height: PROP_H }}
              />
              {group.rows.map((row) => (
                <UnitTrack
                  key={row.unit.id}
                  row={row}
                  days={days}
                  window={window}
                  propertyName={group.property.name}
                  onCreateAt={onCreateAt}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DayHeader({ day }: { day: Day }) {
  return (
    <div
      style={{ width: DAY_W }}
      className={`flex shrink-0 flex-col items-center justify-center ${day.isWeekend ? "bg-muted/60" : ""}`}
    >
      <span className="text-[10px] text-muted-foreground">
        {WEEKDAY[day.dow]}
      </span>
      <span className="text-xs font-medium tabular-nums text-foreground">
        {day.dom}
      </span>
    </div>
  );
}

function UnitTrack({
  row,
  days,
  window,
  propertyName,
  onCreateAt,
}: {
  row: CalendarRow;
  days: Day[];
  window: Window;
  propertyName: string;
  onCreateAt: (seed: CreateSeed) => void;
}) {
  // An archived Unit is retired from every new-booking path (ADR-0006), so its
  // cells don't invite a create - the server would 409 anyway.
  const canCreate = !row.archived;
  return (
    <div className="relative border-b border-border" style={{ height: ROW_H }}>
      {/* Background day cells: gridlines + a weekend tint. On an active Unit each
          cell is a real <button> that opens the block / walk-in dialog for that
          day (accessible + a hit target); an archived row's cells are inert divs.
          Bars paint on top, so a click on a booking hits the bar, not the cell. */}
      {days.map((day, i) => {
        const cls = `absolute bottom-0 top-0 border-r border-border/50 ${day.isWeekend ? "bg-muted/40" : ""}`;
        const geo = { left: i * DAY_W, width: DAY_W };
        return canCreate ? (
          <button
            key={day.date}
            type="button"
            aria-label={`Add a booking on ${day.date} in ${row.unit.name}`}
            onClick={() =>
              onCreateAt({
                unitId: row.unit.id,
                unitName: row.unit.name,
                propertyName,
                basePriceIdr: row.unit.basePriceIdr,
                checkIn: day.date,
              })
            }
            className={`${cls} hover:bg-primary/5`}
            style={geo}
          />
        ) : (
          <div key={day.date} className={cls} style={geo} />
        );
      })}
      {/* Bars. Occupying bookings never overlap on one unit (the exclusion
          constraint, boss fight #1), so this row is a clean non-overlapping
          sequence - no stacking to solve. */}
      {row.bookings.map((booking) => {
        const span = barSpan(window, booking.checkIn, booking.checkOut);
        if (!span) return null;
        return <Bar key={booking.id} booking={booking} span={span} />;
      })}
    </div>
  );
}

function Bar({ booking, span }: { booking: BookingRow; span: BarSpan }) {
  const meta = SOURCE_META[booking.source];
  const isHold = booking.status === "pending_payment";
  const width = (span.end - span.start) * DAY_W - 4;
  const showLabel = span.end - span.start >= 2;

  return (
    <Link
      to="/app/bookings/$bookingId"
      params={{ bookingId: booking.id }}
      title={barTitle(booking)}
      className="absolute flex items-center overflow-hidden rounded-md px-1.5 text-[11px] font-medium no-underline ring-ring hover:ring-2"
      style={{
        left: span.start * DAY_W + 2,
        width,
        top: 6,
        height: ROW_H - 12,
        backgroundColor: meta.cssVar,
        color: "var(--background)",
        textShadow: "0 1px 1px rgba(0,0,0,.35)",
        // Flatten the radius on an edge the stay runs past, so it reads as
        // "continues" rather than "ends here".
        borderTopLeftRadius: span.continuesLeft ? 0 : undefined,
        borderBottomLeftRadius: span.continuesLeft ? 0 : undefined,
        borderTopRightRadius: span.continuesRight ? 0 : undefined,
        borderBottomRightRadius: span.continuesRight ? 0 : undefined,
        // A hold (unpaid) is the same source hue, hatched.
        ...(isHold && {
          backgroundImage:
            "repeating-linear-gradient(45deg, transparent, transparent 5px, rgba(255,255,255,.35) 5px, rgba(255,255,255,.35) 10px)",
        }),
      }}
    >
      {span.continuesLeft && (
        <span aria-hidden className="mr-0.5 shrink-0">
          ‹
        </span>
      )}
      {showLabel && (
        <span className="truncate">{booking.guestName ?? meta.label}</span>
      )}
      {span.continuesRight && (
        <span aria-hidden className="ml-auto shrink-0 pl-0.5">
          ›
        </span>
      )}
    </Link>
  );
}

/** The hover tooltip: who, when, how long, source - and for a live hold, the
 * countdown (page-spec §4.1 edge). */
function barTitle(booking: BookingRow): string {
  const meta = SOURCE_META[booking.source];
  const who = booking.guestName ?? meta.label;
  const nights = countNights(booking.checkIn, booking.checkOut);
  const base = `${who} · ${booking.checkIn} → ${booking.checkOut} (${nights} night${nights === 1 ? "" : "s"}) · ${meta.label}`;
  if (booking.status === "pending_payment" && booking.holdExpiresAt) {
    const mins = Math.round(
      (Date.parse(booking.holdExpiresAt) - Date.now()) / 60_000,
    );
    return `${base} · ${mins > 0 ? `hold expires in ${mins} min` : "hold expired"}`;
  }
  return base;
}
