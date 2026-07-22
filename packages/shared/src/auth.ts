/**
 * Auth contract (FR-AUTH-1). Shared by api (validates input) and web (types).
 */
import { z } from "zod";

import { strictObject } from "./strict";

export const userRoleSchema = z.enum(["owner", "staff"]);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Signup: creates a tenant + its owner user. */
export const registerRequestSchema = strictObject({
  tenantName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = strictObject({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Public view of a user — never includes the password hash.
 *
 * `role` and `tenantId` describe the ACTIVE membership, not the person (#154,
 * ADR-0034): the same account can be an owner here and staff somewhere else, so
 * these two fields change when the session switches tenant. `id` and `email` are
 * the only fields that belong to the human.
 */
export const userDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: userRoleSchema,
  tenantId: z.string().uuid(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const tenantDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type TenantDto = z.infer<typeof tenantDtoSchema>;

/**
 * One Tenant this account can act in, and the role it holds there (#154).
 *
 * Carries the tenant NAME as well as the id because its only consumer is the
 * switcher, which has to render something a person recognises. Every entry is a
 * tenant the caller is already a member of, so listing them reveals nothing they
 * could not already reach.
 */
export const membershipDtoSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  role: userRoleSchema,
});
export type MembershipDto = z.infer<typeof membershipDtoSchema>;

/**
 * Auth result. The access token is returned in the BODY (kept in memory by the
 * client); the refresh token is set as an httpOnly cookie, never in this body.
 * (architecture.md §4.4)
 *
 * `memberships` is every Tenant the account can act in - one entry for most
 * people, and the reason the switcher exists for the rest. `user`/`tenant`
 * describe whichever one this session is currently in.
 */
export const authResponseSchema = z.object({
  accessToken: z.string(),
  user: userDtoSchema,
  tenant: tenantDtoSchema,
  memberships: z.array(membershipDtoSchema),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

/** GET /auth/me — the current session, scoped to the caller's tenant. */
export const meResponseSchema = z.object({
  user: userDtoSchema,
  tenant: tenantDtoSchema,
  memberships: z.array(membershipDtoSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * POST /auth/session — act in a different Tenant (#154, ADR-0034).
 *
 * Authenticated: you must already hold a valid access token, and the membership
 * is verified for THAT user. An unknown or unheld tenant is a 404, so this can
 * never be used to discover which tenants exist.
 */
export const switchTenantRequestSchema = strictObject({
  tenantId: z.string().uuid(),
});
export type SwitchTenantRequest = z.infer<typeof switchTenantRequestSchema>;
