/**
 * A minimal, correct RFC-5545 (iCalendar) serializer for the export feed
 * (api-spec §7.6, #55). Hand-rolled rather than the `ics` npm dependency: an
 * all-day VEVENT is trivial iCalendar, and owning the ~80 lines buys exact
 * control over the two guarantees that matter here -
 *
 *  1. **No PII, by construction.** A `CalendarEvent` carries only an opaque `uid`
 *     and two dates. There is no field for a guest name, email, phone, or price,
 *     so this URL - which the owner pastes into OTAs - CANNOT leak one. The
 *     SUMMARY is a fixed constant, not caller text.
 *  2. **Half-open maps natively.** Sambung stores a stay as `[check_in, check_out)`
 *     (invariant #4). An iCalendar all-day `DTEND;VALUE=DATE` is ALSO exclusive -
 *     it names the day AFTER the last occupied night. So `DTSTART = check_in`,
 *     `DTEND = check_out`, with zero arithmetic: the guest leaves on the checkout
 *     morning, and an OTA reading the feed sees that night as free, exactly right.
 *
 * Output is CRLF-terminated with long lines folded at 75 octets (RFC 5545 §3.1),
 * so real calendar clients and OTAs parse it.
 */

/**
 * One busy span. `uid` is the booking id (an opaque UUID - identifies the block
 * for the OTA's dedup, carries no PII). `start`/`end` are `YYYY-MM-DD` calendar
 * dates; `end` is EXCLUSIVE (the checkout date). No other fields exist on purpose.
 */
export interface CalendarEvent {
  uid: string;
  start: string;
  end: string;
}

export interface BuildCalendarInput {
  /** iCalendar PRODID - identifies the producer. */
  prodId: string;
  events: CalendarEvent[];
  /** DTSTAMP for every event (when the feed was generated). Injectable so a test
   * gets a deterministic body; defaults to now. */
  dtstamp?: Date;
}

// The one text every event shows. Fixed, never guest-derived (guarantee #1
// above): an OTA subscriber only needs to know the night is unavailable.
export const EVENT_SUMMARY = 'Unavailable (Sambung)';

const CRLF = '\r\n';

export function buildCalendar(input: BuildCalendarInput): string {
  const stamp = formatDateTimeUtc(input.dtstamp ?? new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(input.prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const event of input.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      // VALUE=DATE makes these all-day; DTEND stays exclusive (see the header).
      `DTSTART;VALUE=DATE:${formatDate(event.start)}`,
      `DTEND;VALUE=DATE:${formatDate(event.end)}`,
      `SUMMARY:${escapeText(EVENT_SUMMARY)}`,
      // OPAQUE = "this time is busy", the whole point of an availability export.
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  // Fold each line, then join with CRLF, and terminate the last line too.
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** `YYYY-MM-DD` → `YYYYMMDD` (iCalendar DATE). Guards the shape so a malformed
 * date can't emit a broken line silently. */
function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`buildCalendar: not a YYYY-MM-DD date: ${isoDate}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** A Date → `YYYYMMDDTHHMMSSZ` (iCalendar UTC DATE-TIME), from its ISO string. */
function formatDateTimeUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Escape iCalendar TEXT (RFC 5545 §3.3.11): backslash, semicolon, comma, and
 * newlines. The only dynamic text here is `uid` (a UUID) and the fixed summary,
 * but escaping is cheap correctness that outlives the assumption. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to <= 75 OCTETS per RFC 5545 §3.1: a break inserts CRLF +
 * a single leading space, which parsers unfold by dropping them. Counts UTF-8
 * bytes (a multi-byte char must not be split), so the loop walks code points and
 * measures each in bytes.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  let out = '';
  let current = '';
  let bytes = 0;
  let first = true;
  for (const ch of line) {
    const chBytes = encoder.encode(ch).length;
    // Continuation lines start with a space, so their budget is 74 octets.
    const limit = first ? 75 : 74;
    if (bytes + chBytes > limit) {
      out += (first ? '' : ' ') + current + CRLF;
      first = false;
      current = ch;
      bytes = chBytes;
    } else {
      current += ch;
      bytes += chBytes;
    }
  }
  out += (first ? '' : ' ') + current;
  return out;
}
