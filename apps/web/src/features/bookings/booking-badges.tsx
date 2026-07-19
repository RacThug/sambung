import { type BookingSource, type BookingStatus } from "@sambung/shared";
import { SOURCE_META } from "../calendar/calendar-model";
import { STATUS_LABEL } from "./booking-display";

/**
 * The owner-facing booking badges, shared by every dashboard surface that lists or
 * shows a booking - the reservations table (#51), the detail page (#50), and (later)
 * the calendar's drawer. One definition of the status pill's tone and the source dot,
 * so the surfaces can never drift (the status pill used to live private to the detail
 * page). All semantic tokens, so it themes with the dashboard (ADR-0007). Pure copy
 * and helpers live in `booking-display.ts`; this file exports only components.
 */

const STATUS_TONE: Record<BookingStatus, string> = {
  confirmed: "bg-primary/10 text-primary",
  pending_payment: "bg-muted text-foreground",
  cancelled: "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The coloured source dot + label. The dot is the exact solid colour the
 * calendar bars use (SOURCE_META), so a booking reads the same across the
 * calendar, the table and the detail page. `manual_block` reads as "Manual". */
export function SourceBadge({ source }: { source: BookingSource }) {
  const { label, cssVar } = SOURCE_META[source];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: cssVar }}
      />
      {label}
    </span>
  );
}
