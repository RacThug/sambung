import type { HttpException } from '@nestjs/common';
import { pgError } from '@sambung/db';
import { emailTaken } from './conflicts';

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
 * M2: booking_no_overlap → overlap (§5.3)
 * M3: payment_event_provider_event_uniq → already processed (§6.2)
 * M4: booking_external_uid_uniq → already imported (§7.3)
 */
const MAP: Record<string, () => HttpException> = {
  app_user_email_key: emailTaken,
};

/**
 * The HttpException a database error means, or undefined if we have no opinion.
 *
 * Undefined is deliberate and load-bearing: an unmapped violation is a
 * constraint nobody thought about, which is a bug. It must surface as a 500,
 * not as a guessed 409 that makes a broken write look like a user error.
 */
export function mapDbError(err: unknown): HttpException | undefined {
  const constraint = pgError(err)?.constraint;
  return constraint ? MAP[constraint]?.() : undefined;
}
