import { SetMetadata } from '@nestjs/common';

/**
 * Rate-limit tiers (api-spec §8.3, #59). The whole API is guarded by a GENEROUS
 * `default` throttler (#48); a handful of routes are abuse-prone and deserve a
 * TIGHTER `sensitive` throttler on top - auth login/register (credential
 * guessing / signup flooding) and the no-auth public booking write (calendar
 * griefing). Rather than hard-wire a route list into the module, a route opts in
 * with `@ThrottleSensitive()`; the module's `skipIf` reads this metadata and
 * skips the tight throttler everywhere it is absent. Greppable, and the decision
 * lives next to the route it protects.
 */
export const THROTTLE_SENSITIVE = 'throttle:sensitive';

/** Mark a handler (or controller) as abuse-prone so the tighter `sensitive`
 * throttler applies to it (api-spec §8.3). Everywhere else, only the generous
 * `default` throttler runs. */
export const ThrottleSensitive = (): MethodDecorator & ClassDecorator =>
  SetMetadata(THROTTLE_SENSITIVE, true);
