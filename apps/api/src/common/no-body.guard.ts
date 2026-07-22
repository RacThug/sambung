import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { noBodyRequestSchema } from '@sambung/shared';
import { ZodValidationPipe } from './pipes/zod-validation.pipe';

/**
 * Refuses a request body on a route that takes no arguments (#152) - the
 * verb-subresource POSTs, plus `auth/refresh` and `auth/logout`. Applied by
 * `@NoBody()`, never registered globally.
 *
 * The gap it closes is the one ADR-0031 opens with: a route with no `@Body`
 * decorator has no schema to make strict, so Nest never reads the body and
 * `POST /bookings/:id/cancel {"refund":"full"}` answered 200 having ignored it -
 * success and caller-bug indistinguishable, which is exactly what #150 removed
 * everywhere a schema existed. `cancel` is the sharpest case: it is the verb most
 * likely to grow a `reason` or `refund` argument, so a caller guessing at one
 * today must be told it does not exist yet.
 *
 * It reuses `ZodValidationPipe` over the shared `noBodyRequestSchema` rather than
 * hand-rolling an "is it empty" check, so the refusal is byte-identical to every
 * other unknown-key 400 - one instrument, one answer, no second convention to
 * drift (ADR-0012).
 *
 * A guard, not a `@Body(...)` parameter: the parameter form would add eleven
 * arguments that exist only for a side effect, while a route-local marker with
 * the behaviour behind it is the shape already used twice here (`@Roles` +
 * `RolesGuard`, `@ThrottleSensitive` + `skipIf`). Guards throwing something other
 * than a 403 is established too - `EnvelopeThrottlerGuard` throws 429.
 *
 * Two honest limits:
 *  - It reads `req.body`, so a body sent with a NON-JSON content type is never
 *    parsed and stays invisible. Nothing here reads a raw body, so such a request
 *    is ignored just as completely either way.
 *  - Being per-route, a future body-less POST can forget the marker. That is what
 *    `no-body.spec.ts` enumerates: every route either declares a `@Body` or
 *    carries `@NoBody()`, so forgetting fails the suite rather than shipping.
 *
 * Ordering: controller-level guards run first, so on an authenticated route an
 * anonymous caller still gets 401 - the body is never a hint about the session.
 */
@Injectable()
export class NoBodyGuard implements CanActivate {
  private readonly pipe = new ZodValidationPipe(noBodyRequestSchema);

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    // Express's body parser sets `{}` when no body was sent, which is what the
    // SPA does for every one of these calls - so this passes an absent body.
    this.pipe.transform(req.body ?? {});
    return true;
  }
}
