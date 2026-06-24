/**
 * Auth contract (FR-AUTH-1). Shared by api (validates input) and web (types).
 */
import { z } from "zod";

export const userRoleSchema = z.enum(["owner", "staff"]);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Signup: creates a tenant + its owner user. */
export const registerRequestSchema = z.object({
  tenantName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Public view of a user — never includes the password hash. */
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
 * Auth result. The access token is returned in the BODY (kept in memory by the
 * client); the refresh token is set as an httpOnly cookie, never in this body.
 * (architecture.md §4.4)
 */
export const authResponseSchema = z.object({
  accessToken: z.string(),
  user: userDtoSchema,
  tenant: tenantDtoSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

/** GET /auth/me — the current session, scoped to the caller's tenant. */
export const meResponseSchema = z.object({
  user: userDtoSchema,
  tenant: tenantDtoSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;
