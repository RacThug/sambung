/**
 * Tenant payment-credential contract (PRD-product P0-6, REQ-PA-04, ADR-0039).
 * Shared by api (validates the PUT at the boundary, frames the status read) and
 * web (the Payments section on /app/settings).
 *
 * The asymmetry IS the design: the request schema is the ONLY place a server
 * key exists on the wire, inbound only. No response schema in this package has
 * a field for it - not masked, not truncated (last-4 is partial readback) - so
 * "the key can never leak through an endpoint" is a tsc-checkable property of
 * the contract, not a discipline (EARS CR-02).
 */
import { z } from "zod";
import { paymentProviderSchema } from "./payment";
import { strictObject } from "./strict";

/**
 * Which Midtrans base URL this credential speaks to. Per CREDENTIAL, not per
 * process: one deployment serves a demo tenant on sandbox beside a real tenant
 * on production (EARS CR-04).
 */
export const paymentEnvironmentSchema = z.enum(["sandbox", "production"]);
export type PaymentEnvironment = z.infer<typeof paymentEnvironmentSchema>;

/**
 * The outcome of the last verify-on-save call against the provider (EARS
 * CR-03). INFORMATION, not a gate: online checkout keys on the credential
 * EXISTING, because refusing to store a key the provider was too unreachable
 * to confirm would let a Midtrans outage block a valid key (#55's smoke-fetch
 * rule). `unchecked` = stored without a live call (the seed's demo credential).
 */
export const credentialVerifyStatusSchema = z.enum([
  "ok",
  "failed",
  "unchecked",
]);
export type CredentialVerifyStatus = z.infer<
  typeof credentialVerifyStatusSchema
>;

/**
 * Body of `PUT /settings/payment-credentials/:provider` - an idempotent upsert;
 * replacing a key is the same verb. Owner-only (EARS CR-05).
 *
 * `serverKey` is deliberately shape-agnostic: the key format is Midtrans's to
 * change (`SB-Mid-server-…` today), so the boundary checks only that something
 * real was pasted - trimmed, bounded for sanity, never pattern-matched. A wrong
 * key is caught by verify-on-save, not by a regex that rots.
 */
export const savePaymentCredentialRequestSchema = strictObject({
  serverKey: z.string().trim().min(8).max(256),
  environment: paymentEnvironmentSchema,
});
export type SavePaymentCredentialRequest = z.infer<
  typeof savePaymentCredentialRequestSchema
>;

/**
 * Everything the Owner may know about a stored credential (EARS CR-02): that
 * one exists, for which provider and environment, when it was saved, and how
 * the last verification went. `lastVerifyAt` is null iff status is `unchecked`.
 */
export const paymentCredentialStatusResponseSchema = z.object({
  provider: paymentProviderSchema,
  environment: paymentEnvironmentSchema,
  configuredAt: z.string(), // ISO-8601 UTC
  lastVerifyStatus: credentialVerifyStatusSchema,
  lastVerifyAt: z.string().nullable(), // ISO-8601 UTC or null
});
export type PaymentCredentialStatusResponse = z.infer<
  typeof paymentCredentialStatusResponseSchema
>;

/**
 * The 200 for `GET /settings/payment-credentials`: one status per configured
 * provider. Empty array = nothing configured - which is a supported state, not
 * an error (ADR-0039 decision 4), so the read never 404s.
 */
export const listPaymentCredentialsResponseSchema = z.array(
  paymentCredentialStatusResponseSchema,
);
export type ListPaymentCredentialsResponse = z.infer<
  typeof listPaymentCredentialsResponseSchema
>;
