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

/**
 * unit.(property_id, name) is UNIQUE (ADR-0001).
 *
 * The odd one out: only ONE layer can produce this. zod cannot check it - the
 * answer depends on the other rows - so there is no app-level twin here and the
 * constraint isn't a backstop, it IS the check. That's exactly when mapping the
 * name earns its keep, and it's why this maps while the unit CHECKs and the
 * booking FKs deliberately don't: a duplicate name is a legitimate thing for an
 * owner to try, whereas a negative price or a cascade-that-shouldn't-be can only
 * mean the boundary or the delete guard is broken (500, loudly).
 */
export const unitNameTaken = (): HttpException =>
  new ConflictException(
    'A unit with this name already exists in this property',
  );
