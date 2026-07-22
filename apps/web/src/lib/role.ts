import { getSession } from "./auth";

/**
 * Is the signed-in user an account owner? (#57)
 *
 * Read this ONLY to decide what to OFFER, never to decide what is allowed. The
 * server is the authority - `@Roles('owner')` returns 403 whatever this says,
 * and property scoping is enforced by RLS below even that. What this buys is
 * that a staff member is not shown a button whose only outcome is an error.
 *
 * Not a hook and not reactive, deliberately: the role travels in the access
 * token and cannot change without a new session, which remounts the tree. A
 * `useState` here would imply it can change under a mounted component, which
 * would be a lie worth debugging one day.
 */
export function isOwner(): boolean {
  return getSession()?.user.role === "owner";
}
