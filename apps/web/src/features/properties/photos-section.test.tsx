import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { DEFAULT_GALLERY_CAP, type PropertyResponse } from "@sambung/shared";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
  json,
  propertyResponse as property,
  renderAt,
  stubFetch,
  tenantSettingsResponse,
} from "../../test-utils";

// The real PUT-to-storage is exercised by the API e2e suite against Garage;
// here it resolves instantly so the tests cover the flow around it.
vi.mock("../../lib/upload", () => ({
  uploadToPresignedUrl: vi.fn(() => Promise.resolve()),
}));

const PROPERTY_ID = property().id;

function photo(key: string) {
  return { key, url: `http://photos.local/${key}` };
}

/**
 * GET returns `row`; PATCH echoes the sent keys back and records them.
 * `galleryCap` stubs `GET /settings` - the section reads the tenant's cap from
 * there rather than a constant (#67), so it is part of this page's fixture.
 */
function stubPhotosApi(row: PropertyResponse, galleryCap = DEFAULT_GALLERY_CAP) {
  const patched: string[][] = [];
  const calls = stubFetch({
    [`GET /api/properties/${PROPERTY_ID}`]: () => json(row),
    "GET /api/settings": () => json(tenantSettingsResponse({ galleryCap })),
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

  // The cap is the tenant's, fetched from /settings (#67, ADR-0030).
  describe("the tenant's gallery cap", () => {
    it("blocks adding at the tenant's cap, not at the system ceiling", async () => {
      // Two photos, cap of two: full - even though the ceiling is far higher.
      stubPhotosApi(
        property({ photos: [photo("t/p/a.jpg"), photo("t/p/b.jpg")] }),
        2,
      );
      renderAt(`/app/properties/${PROPERTY_ID}`);

      const notice = await screen.findByText(/Gallery is full \(2 photos\)/);
      expect(screen.getByRole("button", { name: "Add photos" })).toBeDisabled();
      // And it points at where to change it. Scoped to the notice: the dashboard
      // nav has a Settings link of its own.
      expect(within(notice).getByRole("link", { name: "Settings" })).toHaveAttribute(
        "href",
        "/app/settings",
      );
    });

    it("still allows adding below the cap", async () => {
      stubPhotosApi(property({ photos: [photo("t/p/a.jpg")] }), 2);
      renderAt(`/app/properties/${PROPERTY_ID}`);

      await screen.findByText("Photos");
      // Enabled once the cap arrives - it starts disabled by design.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Add photos" }),
        ).not.toBeDisabled(),
      );
      expect(screen.queryByText(/Gallery is full/)).not.toBeInTheDocument();
    });

    it("keeps an over-cap gallery fully editable - removal still works", async () => {
      // Three photos under a cap of one: the owner lowered it after uploading.
      // Nothing was deleted, and the way back down must stay open.
      const { patched } = stubPhotosApi(
        property({
          photos: [photo("t/p/a.jpg"), photo("t/p/b.jpg"), photo("t/p/c.jpg")],
        }),
        1,
      );
      renderAt(`/app/properties/${PROPERTY_ID}`);

      expect(await screen.findAllByAltText(/Photo \d+ of/)).toHaveLength(3);
      fireEvent.click(screen.getByLabelText("Remove photo 1"));

      await waitFor(() =>
        expect(patched).toEqual([["t/p/b.jpg", "t/p/c.jpg"]]),
      );
    });

    it("waits for the cap before offering an upload", async () => {
      // /settings held pending: the cap is unknown but nothing has failed. A
      // disabled button for a beat beats a guessed limit that would either block
      // a legal upload or wave one through to a 400.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      stubFetch({
        [`GET /api/properties/${PROPERTY_ID}`]: () => json(property({})),
        "GET /api/settings": async () => {
          await gate;
          return json(tenantSettingsResponse({ galleryCap: 4 }));
        },
      });
      renderAt(`/app/properties/${PROPERTY_ID}`);

      await screen.findByText("Photos");
      expect(screen.getByRole("button", { name: "Add photos" })).toBeDisabled();
      // Nothing failed, so nothing is claimed to have failed.
      expect(
        screen.queryByText(/couldn’t load your photo limit/),
      ).not.toBeInTheDocument();

      // …and it enables once the cap lands, so the wait really was a wait.
      release();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Add photos" }),
        ).not.toBeDisabled(),
      );
    });

    it("surfaces a failed cap fetch with a retry, instead of a dead button", async () => {
      // The failure mode a bare `cap === undefined` guard hides: /settings
      // errors and "Add photos" is disabled forever with nothing explaining it.
      let attempts = 0;
      stubFetch({
        [`GET /api/properties/${PROPERTY_ID}`]: () => json(property({})),
        "GET /api/settings": () => {
          attempts += 1;
          return attempts === 1
            ? new Response(null, { status: 500 })
            : json(tenantSettingsResponse({ galleryCap: 4 }));
        },
      });
      renderAt(`/app/properties/${PROPERTY_ID}`);

      const retry = await screen.findByRole("button", { name: "Retry" });
      expect(
        screen.getByText(/couldn’t load your photo limit/),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add photos" })).toBeDisabled();

      fireEvent.click(retry);

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Add photos" }),
        ).not.toBeDisabled(),
      );
      expect(
        screen.queryByText(/couldn’t load your photo limit/),
      ).not.toBeInTheDocument();
      // The gallery below never depended on the cap: removal and reorder are
      // unaffected by the failure, which is why only the button was disabled.
      expect(DEFAULT_GALLERY_CAP).toBe(30);
    });
  });
});
