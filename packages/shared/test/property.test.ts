import { describe, expect, it } from "vitest";
import {
  createPropertyRequestSchema,
  isPublishable,
  isVerified,
  updatePropertyRequestSchema,
} from "../src/property";

describe("createPropertyRequestSchema", () => {
  it("accepts a minimal valid body", () => {
    expect(createPropertyRequestSchema.parse({ name: "Villa Sunset" })).toEqual(
      { name: "Villa Sunset" },
    );
  });

  it("trims and rejects a too-short name", () => {
    expect(() => createPropertyRequestSchema.parse({ name: " V " })).toThrow();
  });

  it("rejects a missing name", () => {
    expect(() => createPropertyRequestSchema.parse({})).toThrow();
  });

  it("normalizes empty and whitespace licenseNo to null", () => {
    expect(
      createPropertyRequestSchema.parse({ name: "Villa", licenseNo: "" })
        .licenseNo,
    ).toBeNull();
    expect(
      createPropertyRequestSchema.parse({ name: "Villa", licenseNo: "   " })
        .licenseNo,
    ).toBeNull();
  });

  it("keeps a real licenseNo, trimmed", () => {
    expect(
      createPropertyRequestSchema.parse({
        name: "Villa",
        licenseNo: " NIB-123 ",
      }).licenseNo,
    ).toBe("NIB-123");
  });

  it("enforces latitude/longitude ranges", () => {
    expect(() =>
      createPropertyRequestSchema.parse({ name: "Villa", latitude: 91 }),
    ).toThrow();
    expect(() =>
      createPropertyRequestSchema.parse({ name: "Villa", longitude: -181 }),
    ).toThrow();
    expect(
      createPropertyRequestSchema.parse({
        name: "Villa",
        latitude: -8.65,
        longitude: 115.13,
      }),
    ).toMatchObject({ latitude: -8.65, longitude: 115.13 });
  });
});

describe("updatePropertyRequestSchema", () => {
  it("accepts an empty patch", () => {
    expect(updatePropertyRequestSchema.parse({})).toEqual({});
  });

  it("allows clearing optional fields with null", () => {
    expect(
      updatePropertyRequestSchema.parse({ licenseNo: null, address: null }),
    ).toEqual({ licenseNo: null, address: null });
  });

  it("never allows a null name", () => {
    expect(() => updatePropertyRequestSchema.parse({ name: null })).toThrow();
  });

  it("still validates present fields", () => {
    expect(() => updatePropertyRequestSchema.parse({ name: "x" })).toThrow();
  });
});

describe("isVerified (FR-PROP-3)", () => {
  it("is true only for a non-empty license", () => {
    expect(isVerified("NIB-1234567890")).toBe(true);
    expect(isVerified(null)).toBe(false);
    expect(isVerified(undefined)).toBe(false);
    expect(isVerified("")).toBe(false);
    expect(isVerified("   ")).toBe(false);
  });
});

describe("isPublishable (FR-PROP-1 AC)", () => {
  it("requires BOTH a photo and a priced unit", () => {
    expect(isPublishable({ photoCount: 1, pricedUnitCount: 1 })).toBe(true);
    expect(isPublishable({ photoCount: 0, pricedUnitCount: 1 })).toBe(false);
    expect(isPublishable({ photoCount: 1, pricedUnitCount: 0 })).toBe(false);
    expect(isPublishable({ photoCount: 0, pricedUnitCount: 0 })).toBe(false);
  });
});
