import { SetMetadata } from '@nestjs/common';
import type { UserPrincipal } from '../tenant-context.service';

export const ROLES_KEY = 'roles';

/**
 * Restrict a handler (or controller) to the listed roles (#67).
 *
 * The first role check in the codebase, built in #67 as the seam #57 then
 * extended rather than a rival to it: one decorator, one guard, applied where a
 * role genuinely decides the answer.
 *
 * The role it reads is a fact about a MEMBERSHIP, not about a person (#154,
 * ADR-0034): it rides on the access token, which is minted from the membership
 * the session is acting in, so the same account can be refused here at one
 * Tenant and admitted at another. (It lived on `app_user.role` until migration
 * 0016 moved it.)
 *
 * Property-scoped permissions - which properties a staff member may touch, via
 * `user_property` - are a different question and are NOT modelled here. They are
 * RLS's second axis (ADR-0032), which is why an unassigned property is a 404
 * while a role refusal is a 403: two questions, two mechanisms, no second
 * authorization path to reconcile.
 */
export const Roles = (
  ...roles: UserPrincipal['role'][]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
