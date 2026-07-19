import { Link, useNavigate } from "@tanstack/react-router";
import { formatIdr } from "../../lib/money";
import { formatDate } from "../../lib/date";
import { SourceBadge, StatusBadge } from "../bookings/booking-badges";
import { bookingTitle } from "../bookings/booking-display";
import type { ReservationRow } from "./reservations-model";

/**
 * The reservations table (page-spec §4.2). One row per booking, sorted by check-in
 * (the server's order - never re-sorted here). A whole row is a link to the booking
 * detail (§4.3): the row `onClick` is the mouse convenience, the guest-cell `Link`
 * is the keyboard-and-middle-click path, so the row is reachable both ways without a
 * nested-interactive trap.
 */
export function ReservationsTable({ rows }: { rows: ReservationRow[] }) {
  const navigate = useNavigate();

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <Th>Guest</Th>
            <Th>Property</Th>
            <Th>Unit</Th>
            <Th>Check-in</Th>
            <Th>Check-out</Th>
            <Th>Source</Th>
            <Th>Status</Th>
            <Th className="text-right">Total</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ booking, propertyName, unitName }) => (
            <tr
              key={booking.id}
              onClick={() =>
                void navigate({
                  to: "/app/bookings/$bookingId",
                  params: { bookingId: booking.id },
                })
              }
              className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/50"
            >
              <td className="whitespace-nowrap px-3 py-2.5">
                <Link
                  to="/app/bookings/$bookingId"
                  params={{ bookingId: booking.id }}
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-foreground hover:text-primary"
                >
                  {bookingTitle(booking)}
                </Link>
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {propertyName}
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">{unitName}</td>
              <td className="whitespace-nowrap px-3 py-2.5 text-foreground">
                {formatDate(booking.checkIn)}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-foreground">
                {formatDate(booking.checkOut)}
              </td>
              <td className="px-3 py-2.5">
                <SourceBadge source={booking.source} />
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge status={booking.status} />
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right text-foreground">
                {booking.totalPriceIdr === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  formatIdr(booking.totalPriceIdr)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>;
}
