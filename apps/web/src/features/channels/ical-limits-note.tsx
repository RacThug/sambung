/**
 * The one honest paragraph about what iCal can and cannot do (REQ-AV-04, spec
 * UX-05/05a/05b). ONE component, rendered on both the calendar and the property
 * workbench: two surfaces explaining the same truth in two wordings is how a
 * product starts quietly contradicting itself.
 *
 * It leads with the OUTBOUND leg on purpose. "We check your OTA calendars every
 * 30 minutes" is true and reassuring and describes the half that is already safe -
 * the leg we control. The dangerous one is the other direction: Airbnb documents
 * that it re-reads a connected calendar about every 3 hours and rate-limits being
 * asked more often, so a direct booking here can sit unblocked over there for
 * hours, and no amount of engineering on our side shortens that.
 * (docs/research/ical-sync-cadence.md §4.)
 *
 * Permanent copy, not a dismissible tooltip: this is a standing property of iCal,
 * not an onboarding step to get past.
 */
export function IcalLimitsNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-muted-foreground ${className}`}>
      <span className="font-medium text-foreground">
        OTAs re-read your calendar on their own schedule
      </span>{" "}
      - Airbnb documents about every 3 hours - so a booking taken here can take
      that long to block the dates on Airbnb or Booking.com. Sambung pulls their
      calendars the other way every 30 minutes. iCal cannot prevent every double
      booking; to close a date immediately, use the OTA’s own “Refresh” on its
      calendar-sync page, and keep each unit’s export link pasted into every
      channel.
    </p>
  );
}
