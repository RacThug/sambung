import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { PropertyResponse } from "@sambung/shared";
import { clearSession, setSession } from "../../lib/auth";
import { authResponse, json, renderAt, stubFetch } from "../../test-utils";

// The real PUT-to-storage is exercised by the API e2e suite against Garage;
// here it resolves instantly so the tests cover the flow around it.
vi.mock("../../lib/upload", () => ({
  uploadToPresignedUrl: vi.fn(() => Promise.resolve()),
}));

const PROPERTY_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function photo(key: string) {
  return { key, url: `http://photos.local/${key}` };
}

function property(overrides: Partial<PropertyResponse>): PropertyResponse {
  return {
    id: PROPERTY_ID,
    tenantId: authResponse().tenant.id,
    name: "Seminyak Beach Villa",
    address: null,
    latitude: null,
    longitude: null,
    description: null,
    licenseNo: null,
    photos: [],
    verified: false,
    publishable: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** GET returns `row`; PATCH echoes the sent keys back and records them. */
function stubPhotosApi(row: PropertyResponse) {
  const patched: string[][] = [];
  const calls = stubFetch({
    [`GET /api/properties/${PROPERTY_ID}`]: () => json(row),
    [`POST /api/properties/${PROPERTY_ID}/photos/presign`]: () =>
      json(
        {
          uploadUrl: "http://storage.local/put",
          key: `${row.tenantId}/${PROPERTY_ID}/new-photo.jpg`,
          expiresInSeconds: 300,
        },
        201,
      ),
    [`PATCH /api/properties/${PROPERTY_ID}/photos`]: (init) => {
      const body = JSON.parse(String(init?.body)) as { keys: string[] };
      patched.push(body.keys);
      return json(property({ photos: body.keys.map(photo) }));
    },
  });
  return { patched, calls };
}

beforeEach(() => {
  setSession(authResponse());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

describe("photos section (§4.5, #39)", () => {
  it("renders the gallery in order with the first photo as cover", async () => {
    stubPhotosApi(property({ photos: [photo("t/p/a.jpg"), photo("t/p/b.jpg")] }));
    renderAt(`/app/properties/${PROPERTY_ID}`);

    const first = await screen.findByAltText(/Photo 1 of/);
    expect(first).toHaveAttribute("src", "http://photos.local/t/p/a.jpg");
    expect(screen.getByText("Cover")).toBeInTheDocument();
    expect(screen.getAllByAltText(/Photo \d+ of/)).toHaveLength(2);
  });

  it("removes a photo by PATCHing the remaining set", async () => {
    const { patched } = stubPhotosApi(
      property({ photos: [photo("t/p/a.jpg"), photo("t/p/b.jpg")] }),
    );
    renderAt(`/app/properties/${PROPERTY_ID}`);

    fireEvent.click(await screen.findByLabelText("Remove photo 1"));

    await waitFor(() => expect(patched).toEqual([["t/p/b.jpg"]]));
    // The PATCH response repaints the gallery: one photo left.
    await waitFor(() =>
      expect(screen.getAllByAltText(/Photo \d+ of/)).toHaveLength(1),
    );
  });

  it("reorders by PATCHing the whole set in the new order", async () => {
    const { patched } = stubPhotosApi(
      property({ photos: [photo("t/p/a.jpg"), photo("t/p/b.jpg")] }),
    );
    renderAt(`/app/properties/${PROPERTY_ID}`);

    fireEvent.click(await screen.findByLabelText("Move photo 2 left"));

    await waitFor(() => expect(patched).toEqual([["t/p/b.jpg", "t/p/a.jpg"]]));
  });

  it("rejects a wrong file type before any network call", async () => {
    const { calls } = stubPhotosApi(property({}));
    renderAt(`/app/properties/${PROPERTY_ID}`);
    await screen.findByText("Photos");

    fireEvent.change(screen.getByLabelText("Choose photos"), {
      target: {
        files: [new File(["x"], "brochure.pdf", { type: "application/pdf" })],
      },
    });

    expect(
      await screen.findByText(/Only JPEG, PNG or WebP/),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.includes("presign"))).toHaveLength(0);
  });

  it("rejects an oversized file before any network call", async () => {
    const { calls } = stubPhotosApi(property({}));
    renderAt(`/app/properties/${PROPERTY_ID}`);
    await screen.findByText("Photos");

    const big = new File(["x"], "huge.jpg", { type: "image/jpeg" });
    Object.defineProperty(big, "size", { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("Choose photos"), {
      target: { files: [big] },
    });

    expect(await screen.findByText(/limit is 5 MB/)).toBeInTheDocument();
    expect(calls.filter((c) => c.includes("presign"))).toHaveLength(0);
  });

  it("uploads a file: presign → PUT → PATCH appends the new key", async () => {
    const { patched } = stubPhotosApi(
      property({ photos: [photo("t/p/a.jpg")] }),
    );
    renderAt(`/app/properties/${PROPERTY_ID}`);
    await screen.findByText("Photos");

    fireEvent.change(screen.getByLabelText("Choose photos"), {
      target: {
        files: [new File(["bytes"], "villa.jpg", { type: "image/jpeg" })],
      },
    });

    await waitFor(() =>
      expect(patched).toEqual([
        [
          "t/p/a.jpg",
          `${authResponse().tenant.id}/${PROPERTY_ID}/new-photo.jpg`,
        ],
      ]),
    );
    // Gallery now shows both photos.
    await waitFor(() =>
      expect(screen.getAllByAltText(/Photo \d+ of/)).toHaveLength(2),
    );
  });

  it("surfaces a presign rejection on the failed file", async () => {
    const row = property({});
    stubFetch({
      [`GET /api/properties/${PROPERTY_ID}`]: () => json(row),
      [`POST /api/properties/${PROPERTY_ID}/photos/presign`]: () =>
        json(
          {
            statusCode: 400,
            message: "Validation failed",
            error: "Bad Request",
          },
          400,
        ),
    });
    renderAt(`/app/properties/${PROPERTY_ID}`);
    await screen.findByText("Photos");

    fireEvent.change(screen.getByLabelText("Choose photos"), {
      target: {
        files: [new File(["bytes"], "villa.jpg", { type: "image/jpeg" })],
      },
    });

    expect(await screen.findByText("Validation failed")).toBeInTheDocument();
    // A failed upload can be dismissed.
    fireEvent.click(screen.getByLabelText("Dismiss error for villa.jpg"));
    expect(screen.queryByText("Validation failed")).not.toBeInTheDocument();
  });
});
