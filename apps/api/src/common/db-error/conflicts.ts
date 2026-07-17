import { ConflictException, HttpException } from '@nestjs/common';

/**
 * Domain errors that a database constraint can also produce.
 *
 * Each is a factory, not a string, because two layers arrive at the same
 * answer: an app-level check (a fast path, or a friendlier message) and the
 * constraint that actually guarantees it. api-spec §5.3 requires those to be
 * indistinguishable - "the client cannot tell (and must not care) which layer
 * refused" - so both throw the SAME factory rather than two copies of a string
 * that a typo can silently split apart.
 *
 * The constraint half of the wiring lives in db-error.map.ts.
 */

/** app_user.email is citext UNIQUE. Racing signups both pass the pre-check. */
export const emailTaken = (): HttpException =>
  new ConflictException('Email already registered');
