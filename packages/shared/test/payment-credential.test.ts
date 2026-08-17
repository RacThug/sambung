import { describe, expect, it } from "vitest";
import {
  listPaymentCredentialsResponseSchema,
  paymentCredentialStatusResponseSchema,
  savePaymentCredentialRequestSchema,
} from "../src/payment-credential";

const valid = {
  serverKey: "SB-Mid-server-abc123def456",
  environment: "sandbox",
};

describe("savePaymentCredentialRequestSchema", () => {
  it("accepts a pasted key, trimming the copy-paste whitespace", () => {
    expect(
      savePaymentCredentialRequestSchema.parse({
        ...valid,
        serverKey: "  SB-Mid-server-abc123def456  ",
      }).serverKey,
    ).toBe("SB-Mid-server-abc123def456");
  });

  it("is shape-agnostic about the key - the format is Midtrans's to change", () => {
    // A production-format key (no SB- prefix) and an unfamiliar shape both
    // pass the boundary; verify-on-save is what judges them (EARS CR-03).
    expect(
      savePaymentCredentialRequestSchema.parse({
        ...valid,
        serverKey: "Mid-server-xyz789",
        environment: "production",
      }).environment,
    ).toBe("production");
  });

  it("rejects an empty or absurd paste, and an unknown environment", () => {
    expect(() =>
      savePaymentCredentialRequestSchema.parse({ ...valid, serverKey: "   " }),
    ).toThrow();
    expect(() =>
      savePaymentCredentialRequestSchema.parse({
        ...valid,
        serverKey: "x".repeat(300),
      }),
    ).toThrow();
    expect(() =>
      savePaymentCredentialRequestSchema.parse({
        ...valid,
        environment: "staging",
      }),
    ).toThrow();
  });
});

describe("paymentCredentialStatusResponseSchema (EARS CR-02)", () => {
  const status = {
    provider: "midtrans",
    environment: "sandbox",
    configuredAt: "2026-08-17T03:00:00.000Z",
    lastVerifyStatus: "ok",
    lastVerifyAt: "2026-08-17T03:00:01.000Z",
  };

  it("parses a status row, and an unchecked one with a null verify time", () => {
    expect(paymentCredentialStatusResponseSchema.parse(status)).toEqual(status);
    expect(
      paymentCredentialStatusResponseSchema.parse({
        ...status,
        lastVerifyStatus: "unchecked",
        lastVerifyAt: null,
      }).lastVerifyAt,
    ).toBeNull();
  });

  it("has EXACTLY the fields an owner may know - no key field can ever be added silently", () => {
    // The write-only guarantee, pinned as an exact key list rather than a
    // "does not contain serverKey" check: a leak under any OTHER name
    // (key, secret, ciphertext...) fails this too.
    expect(Object.keys(paymentCredentialStatusResponseSchema.shape).sort()).toEqual([
      "configuredAt",
      "environment",
      "lastVerifyStatus",
      "lastVerifyAt",
      "provider",
    ].sort());
  });

  it("an empty list is the supported not-configured state, not an error", () => {
    expect(listPaymentCredentialsResponseSchema.parse([])).toEqual([]);
  });
});
