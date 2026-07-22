import { UseGuards, applyDecorators } from '@nestjs/common';
import { NoBodyGuard } from '../no-body.guard';

/**
 * Declares that a handler takes no request body, and refuses one (#152).
 *
 * Mark every route that reads no body - the verb-subresources plus
 * `auth/refresh` and `auth/logout`. Without it such a route silently ignores
 * whatever is sent, which is the "indistinguishable from success" failure
 * ADR-0031 removed everywhere a schema existed.
 *
 * Greppable at the route on purpose, stacking with `@Roles` / `@ThrottleSensitive`:
 * the decision about what a route accepts belongs next to the route. The cost of
 * that choice - someone forgetting it on a new route - is paid by the enumeration
 * in `no-body.spec.ts`, which fails when a handler declares neither a `@Body` nor
 * this marker.
 *
 * Composes with a controller-level `@UseGuards`: Nest merges global, controller
 * and handler guards rather than overriding, and the controller's run first.
 */
export const NoBody = (): MethodDecorator =>
  applyDecorators(UseGuards(NoBodyGuard));
