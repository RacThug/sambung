import { SetMetadata } from '@nestjs/common';
import type { UserPrincipal } from '../tenant-context.service';

export const ROLES_KEY = 'roles';

/**
 * Restrict a handler (or controller) to the listed roles (#67).
 *
 * The first role check in the codebase. `app_user.role` has existed since M0 and
 * the access token has always carried it, but nothing read it: registration mints
 * an `owner` and no path creates a `staff` user yet, so every authenticated
 * caller has been an owner in practice. #57 (staff invites + property-scoped
 * RBAC) is where that stops being true.
 *
 * This is deliberately the seam #57 extends rather than a rival to it: one
 * decorator, one guard, applied where a role genuinely decides the answer -
 * today only `PATCH /settings`. Property-scoped permissions (which properties a
 * staff member may touch, via `user_property`) are a different question and are
 * NOT modelled here; answering half of #57 early would be the drift a second
 * authorization path always becomes.
 */
export const Roles = (
  ...roles: UserPrincipal['role'][]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
