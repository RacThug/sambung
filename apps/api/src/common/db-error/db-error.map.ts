import { HttpException } from '@nestjs/common';
import { pgError } from '@sambung/db';
import { emailTaken, unitNameTaken } from './conflicts';

/**
 * Constraint name → the response it means. The database already names the
 * domain fact: `booking_no_overlap` IS "these dates are taken", and mapping it
 * once is what lets a racing insert and an app-level check return the same 409
 * (api-spec §5.3, §8.2).
 *
 * Keyed by constraint NAME, not SQLSTATE: 23505 is "some unique thing already
 * exists", which is not an answer. Postgres reports the name for every named
 * constraint - and, verified, for a partial unique INDEX too, which is what
 * M4's `booking_external_uid_uniq` idempotency will rely on. (Only NOT NULL,
 * 23502, reports no name; zod rejects those at the boundary.)
 *
 * Add a row when the module that can trigger it exists. Pre-mapping constraints
 * with no caller would be guesses that read as decisions - and the status for,
 * say, `booking_stay_nonempty` is a real question only the booking module can
 * answer.
 *
 * The unit CHECKs (unit_base_price_nonneg and friends) and the booking->unit FKs
 * are deliberately ABSENT, though both can fire. Neither has a legitimate
 * trigger: zod rejects a negative price before the CHECK can see it, and
 * UnitsService.remove locks the unit before counting, so no booking can slip in
 * behind the count. If either fires, the boundary or the guard is broken - which
 * is a 500 by design, not a 409 that makes a bug look like a user error.
 *
 * M2: booking_no_overlap → overlap (§5.3)
 * M3: payment_event_provider_event_uniq → already processed (§6.2)
 * M4: booking_external_uid_uniq → already imported (§7.3)
 */
// A Map, not a plain object: constraint names are keys from outside this file,
// and `{}[name]` reaches the prototype. `__proto__` throws, `constructor`
// returns a function, `hasOwnProperty` returns something falsy that isn't
// undefined - so the declared return type would be a lie and the caller's
// `?? err` fallback would not fire. Schema-owned names make that unreachable
// today; a lookup that cannot misbehave costs nothing and outlives the
// assumption.
const MAP = new Map<string, () => HttpException>([
  ['app_user_email_key', emailTaken],
  ['unit_property_name_uniq', unitNameTaken],
]);

/**
 * The HttpException a database error means, or undefined if we have no opinion.
 *
 * Undefined is deliberate and load-bearing: an unmapped violation is a
 * constraint nobody thought about, which is a bug. It must surface as a 500,
 * not as a guessed 409 that makes a broken write look like a user error.
 */
export function mapDbError(err: unknown): HttpException | undefined {
  // An HttpException is already an answer - never second-guess one. pgError
  // walks the `cause` chain, so without this a deliberate
  // `new NotFoundException(msg, { cause: dbErr })` would be rewritten into
  // whatever that cause's constraint maps to: a 404 silently becoming a 409.
  // `{ cause }` is idiomatic and Nest supports it, so this is a trap waiting
  // rather than a hypothetical.
  if (err instanceof HttpException) return undefined;
  const constraint = pgError(err)?.constraint;
  return constraint ? MAP.get(constraint)?.() : undefined;
}
