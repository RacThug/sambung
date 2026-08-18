/**
 * "12 minutes ago" from a timestamp (REQ-AV-04, spec UX-02).
 *
 * The browser PHRASES the age; the server JUDGES whether that age is a problem
 * (`stale` on the wire). The split matters: phrasing tolerates a clock that is a
 * few minutes out - the sentence reads slightly wrong and nothing else happens -
 * while a judgement made on a skewed clock either warns about a healthy feed or
 * stays silent about a dead one.
 *
 * `now` is a parameter, not `new Date()` inside, so a test can state the instant
 * it is asking about instead of freezing global time.
 *
 * English only: this is the dashboard, and the dashboard speaks one language while
 * the funnel speaks three (ADR-0024).
 */
export function formatAge(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);

  // A clock a little behind the server's would otherwise produce "-2 minutes ago".
  // The honest phrasing of a timestamp fractionally in the future is "just now".
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
