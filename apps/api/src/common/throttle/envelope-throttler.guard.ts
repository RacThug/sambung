import {
  HttpException,
  HttpStatus,
  Injectable,
  type ExecutionContext,
} from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';

/**
 * The global rate-limit guard, extended for two client-contract reasons (#59,
 * api-spec §8.3).
 *
 * 1. **Envelope.** `ThrottlerException`'s default body is `{ statusCode, message }`
 *    - built from a bare string, so Nest omits the `error` field every other
 *    refusal carries. The web's `ApiError` reads `{ statusCode, error, message }`,
 *    so a rate-limit refusal must look like a `NotFoundException` or a
 *    `ConflictException`, not a one-off shape. NOT a conflict `code` slug
 *    (ADR-0012): that enum is closed to DOMAIN 409s ("these dates are taken"). A 429
 *    is infrastructure back-pressure, not a fact the client can fix by changing the
 *    request, so it follows the generic envelope.
 *
 * 2. **Standard `Retry-After`.** With NAMED throttlers the base guard emits a
 *    suffixed `Retry-After-sensitive`, which a generic client won't read. We also
 *    set the standard `Retry-After` (seconds) so "when may I retry" is machine-
 *    readable the conventional way.
 *
 * Only `throwThrottlingException` is overridden; the base guard still counts hits,
 * sets its headers, and honours per-throttler `skipIf`. No constructor: Nest
 * resolves the inherited `@InjectThrottlerOptions`/`@InjectThrottlerStorage` deps
 * through the prototype chain (the documented extension pattern).
 */
@Injectable()
export class EnvelopeThrottlerGuard extends ThrottlerGuard {
  protected throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    // getRequestResponse types res as Record<string, any>; narrow to the Express
    // Response so the header set isn't an unsafe `any` invocation.
    const res = this.getRequestResponse(context).res as Response;
    res.setHeader('Retry-After', `${throttlerLimitDetail.timeToBlockExpire}`);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: 'Too many requests - please slow down and try again shortly.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
