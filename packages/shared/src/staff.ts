/**
 * Staff + Invite contract (#57, FR-AUTH-2, api-spec §3.6).
 *
 * Two nouns live here, and keeping them apart is the point:
 *
 * - an **Invite** is an offer of a seat, addressed to an email and carrying the
 *   Properties it will grant. It is not a user; nobody can sign in as one.
 * - a **Staff member** is an accepted invite - a real `app_user` with `role:
 *   'staff'` and a set of Assignments.
 *
 * Every route here except accept is `@Roles('owner')`. The accept routes are
 * UNAUTHENTICATED: whoever holds the token is the person the owner emailed, and
 * requiring a session first would be circular - they have no account yet.
 */
import { z } from "zod";

import { strictObject } from "./strict";

/**
 * The Properties one staff member may see. Bounded so an owner cannot post an
 * unbounded array; 1 minimum because a staff account with no assignments can see
 * nothing at all, which is an account that only looks like access.
 */
export const assignedPropertyIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(200);

/**
 * The Invite token as it travels: opaque to everyone but the server, which
 * compares its hash. Bounded so an absurd value is a 400 at the boundary rather
 * than something the hash function is asked to chew through - and shared by the
 * accept BODY and the preview PATH PARAM, which are the same secret arriving two
 * ways and must not disagree about what is acceptable.
 */
export const inviteTokenSchema = z.string().min(1).max(200);

/**
 * A Property named in an Invite or an Assignment: id to act on, name to read.
 * One schema, because the Team screen renders both lists the same way and a
 * second copy is a field that can go missing from one of them.
 */
export const assignedPropertySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type AssignedProperty = z.infer<typeof assignedPropertySchema>;

export const createInviteRequestSchema = strictObject({
  email: z.string().trim().email().max(254),
  propertyIds: assignedPropertyIdsSchema,
});
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

/**
 * A pending invite as the owner's Team screen sees it. Deliberately WITHOUT the
 * token or its hash: the token exists once, in the email. The owner cannot
 * re-read it from this list - if it is lost, the invite is revoked and re-sent.
 * That is a real (small) usability cost, taken because a token an API will hand
 * back is a token every future bug can hand back.
 */
export const inviteDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  properties: z.array(assignedPropertySchema),
});
export type InviteDto = z.infer<typeof inviteDtoSchema>;

export const listInvitesResponseSchema = z.object({
  invites: z.array(inviteDtoSchema),
});
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;

/**
 * What `/invite/:token` renders BEFORE asking for a password: who invited you,
 * and to what. No id, and no property ids - a page reached with an unauthenticated
 * token gets names to recognise, not identifiers to act on.
 */
export const invitePreviewResponseSchema = z.object({
  email: z.string().email(),
  tenantName: z.string(),
  propertyNames: z.array(z.string()),
  expiresAt: z.string().datetime(),
});
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponseSchema>;

/**
 * Accept. The email is NOT in the body - it is whatever the invite says, so a
 * holder cannot redirect a seat to a different address. Password rules mirror
 * register's, because this creates exactly the same kind of account.
 */
export const acceptInviteRequestSchema = strictObject({
  token: inviteTokenSchema,
  password: z.string().min(8).max(200),
});
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

/** A staff member on the Team screen, with the Assignments the owner can edit. */
export const staffMemberDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
  properties: z.array(assignedPropertySchema),
});
export type StaffMemberDto = z.infer<typeof staffMemberDtoSchema>;

export const listStaffResponseSchema = z.object({
  staff: z.array(staffMemberDtoSchema),
});
export type ListStaffResponse = z.infer<typeof listStaffResponseSchema>;

/**
 * Replace a staff member's Assignments. A WHOLE-SET write, like the Gallery
 * (ADR-0030): the array IS the assignment set, so removing access is sending a
 * shorter list rather than a second "unassign" verb.
 */
export const updateStaffRequestSchema = strictObject({
  propertyIds: assignedPropertyIdsSchema,
});
export type UpdateStaffRequest = z.infer<typeof updateStaffRequestSchema>;
