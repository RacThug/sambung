import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
  json,
  propertyResponse,
  renderAt,
  stubFetch,
  unitResponse,
  type FetchStubs,
} from "../../test-utils";

const propertyId = propertyResponse().id;
const editUrl = `/app/properties/${propertyId}`;

/** The edit page fetches the property and its units; both are always stubbed. */
function stubEditPage(extra: FetchStubs = {}, units = [unitResponse()]) {
  return stubFetch({
    [`GET /api/properties/${propertyId}`]: () => json(propertyResponse()),
    [`GET /api/properties/${propertyId}/units`]: () => json(units),
    ...extra,
  });
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

describe("units section (§4.5)", () => {
  it("lists units with rupiah-formatted prices", async () => {
    stubEditPage({}, [
      unitResponse({ name: "Garden Room 1", basePriceIdr: 1_200_000 }),
      unitResponse({
        id: "bbbbbbbb-0000-0000-0000-000000000002",
        name: "Pool Villa",
        basePriceIdr: 3_500_000,
        maxGuests: 4,
        minStay: 2,
      }),
    ]);
    renderAt(editUrl);

    expect(await screen.findByText("Garden Room 1")).toBeInTheDocument();
    expect(screen.getByText("Rp 1.200.000")).toBeInTheDocument();
    expect(screen.getByText("Rp 3.500.000")).toBeInTheDocument();
    expect(screen.getByText("2 nights")).toBeInTheDocument();
    expect(screen.getByText("1 night")).toBeInTheDocument();
  });

  // A zero price is deliberately storable, so the row must explain itself rather
  // than the owner having to infer it from the banner at the top of the page.
  it("marks a zero-priced unit as not sellable", async () => {
    stubEditPage({}, [unitResponse({ basePriceIdr: 0 })]);
    renderAt(editUrl);

    expect(await screen.findByText("not sellable")).toBeInTheDocument();
  });

  it("adds a unit from the always-open add row and sends the typed values", async () => {
    let posted: unknown;
    stubEditPage({
      [`POST /api/properties/${propertyId}/units`]: (init) => {
        posted = JSON.parse(String(init?.body));
        return json(unitResponse({ name: "Garden Room 2" }), 201);
      },
    });
    renderAt(editUrl);

    fireEvent.change(await screen.findByLabelText("New unit name"), {
      target: { value: "Garden Room 2" },
    });
    fireEvent.change(
      screen.getByLabelText("New unit price per night in rupiah"),
      {
        target: { value: "1200000" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));

    await waitFor(() => expect(posted).toBeDefined());
    // Defaults come from the shared schema, not from the server guessing.
    expect(posted).toEqual({
      name: "Garden Room 2",
      basePriceIdr: 1_200_000,
      maxGuests: 2,
      minStay: 1,
    });
  });

  // Bulk entry is the entire case for an inline table over a dialog (ADR-0001:
  // 8 identical rooms are 8 rows), and it only holds if Enter submits.
  it("submits on Enter, then clears the row for the next room", async () => {
    const calls = stubEditPage({
      [`POST /api/properties/${propertyId}/units`]: () =>
        json(unitResponse(), 201),
    });
    renderAt(editUrl);

    const name = await screen.findByLabelText("New unit name");
    fireEvent.change(name, { target: { value: "Garden Room 2" } });
    fireEvent.change(
      screen.getByLabelText("New unit price per night in rupiah"),
      {
        target: { value: "1200000" },
      },
    );
    fireEvent.keyDown(name, { key: "Enter" });

    await waitFor(() =>
      expect(calls).toContain(`POST /api/properties/${propertyId}/units`),
    );
    await waitFor(() => expect(name).toHaveValue(""));
  });

  // Number("") is 0, so a blank price would otherwise create a free room.
  it("rejects a blank price rather than reading it as zero", async () => {
    const calls = stubEditPage();
    renderAt(editUrl);

    fireEvent.change(await screen.findByLabelText("New unit name"), {
      target: { value: "Nameless Price" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));

    expect(
      await screen.findByText(/required|expected number/i),
    ).toBeInTheDocument();
    expect(calls).not.toContain(`POST /api/properties/${propertyId}/units`);
  });

  it("shows zod errors on the field without calling the API", async () => {
    const calls = stubEditPage();
    renderAt(editUrl);

    fireEvent.change(await screen.findByLabelText("New unit name"), {
      target: { value: "Cheap" },
    });
    fireEvent.change(
      screen.getByLabelText("New unit price per night in rupiah"),
      {
        target: { value: "-1" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));

    expect(
      await screen.findByText(/greater than or equal to 0/i),
    ).toBeInTheDocument();
    expect(calls).not.toContain(`POST /api/properties/${propertyId}/units`);
  });

  // zod can't catch this - it needs the other rows - so it arrives as a 409 from
  // the DB constraint and still has to land on the field that caused it.
  it("renders a duplicate-name 409 against the name field", async () => {
    stubEditPage({
      [`POST /api/properties/${propertyId}/units`]: () =>
        json(
          {
            statusCode: 409,
            message: "A unit with this name already exists in this property",
          },
          409,
        ),
    });
    renderAt(editUrl);

    fireEvent.change(await screen.findByLabelText("New unit name"), {
      target: { value: "Garden Room 1" },
    });
    fireEvent.change(
      screen.getByLabelText("New unit price per night in rupiah"),
      {
        target: { value: "1200000" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add unit" }));

    expect(
      await screen.findByText(/already exists in this property/i),
    ).toBeInTheDocument();
  });

  // A 404/500 arrives as an ApiError whose `message` is a plain string, so
  // fieldErrors is {} and a non-ApiError fallback never fires. Relying on those
  // alone rendered NOTHING: "Saving…" flashed and the click looked ignored.
  it("surfaces a save error that maps to no field (unit deleted in another tab)", async () => {
    stubEditPage({
      [`PATCH /api/units/${unitResponse().id}`]: () =>
        json({ statusCode: 404, message: "Unit not found" }, 404),
    });
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit price per night in rupiah"), {
      target: { value: "999000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Unit not found")).toBeInTheDocument();
  });

  it("surfaces a network failure on save", async () => {
    stubEditPage();
    // Unmatched routes 404 by default, so fail the PATCH at the transport layer.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : (realFetch as typeof fetch)(input, init),
    );
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(/something went wrong/i),
    ).toBeInTheDocument();
  });

  // Enter bubbles from the Cancel button too, and onSubmit's preventDefault
  // would suppress its click - so the row would save instead of cancelling.
  it("cancels rather than saves when Enter is pressed on Cancel", async () => {
    const calls = stubEditPage();
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.keyDown(cancel, { key: "Enter" });

    expect(calls).not.toContain(`PATCH /api/units/${unitResponse().id}`);
  });

  it("edits a unit in place and PATCHes it", async () => {
    let patched: unknown;
    stubEditPage({
      [`PATCH /api/units/${unitResponse().id}`]: (init) => {
        patched = JSON.parse(String(init?.body));
        return json(unitResponse({ basePriceIdr: 999_000 }));
      },
    });
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // The edit row's own label - the add row is still on screen below it, and
    // "New unit price…" would grab that one instead.
    fireEvent.change(screen.getByLabelText("Edit price per night in rupiah"), {
      target: { value: "999000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patched).toBeDefined());
    expect(patched).toMatchObject({
      name: "Garden Room 1",
      basePriceIdr: 999_000,
    });
  });

  // ADR-0002: the message names a count and offers no false escape. The row
  // renders the server's own words rather than a second copy of them.
  it("renders the delete 409 reason on the row", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    stubEditPage({
      [`DELETE /api/units/${unitResponse().id}`]: () =>
        json(
          {
            statusCode: 409,
            message:
              "Cannot delete: this unit has 14 bookings - deleting it would destroy that history",
          },
          409,
        ),
    });
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText(/this unit has 14 bookings/i),
    ).toBeInTheDocument();
  });

  it("does not delete when the confirm is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = stubEditPage();
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(calls).not.toContain(`DELETE /api/units/${unitResponse().id}`);
  });

  // Archive (ADR-0005, #84): a self-archived unit under a LIVE property is muted,
  // loses Edit, and offers Unarchive instead of Archive.
  it("marks a self-archived unit and offers Unarchive", async () => {
    stubEditPage({}, [
      unitResponse({ archivedAt: "2026-07-18T00:00:00.000Z" }),
    ]);
    renderAt(editUrl);

    expect(await screen.findByText("Garden Room 1")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unarchive" }),
    ).toBeInTheDocument();
    // Editing a retired unit is meaningless, so the affordance is gone.
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("archives an active unit via the Archive button", async () => {
    const calls = stubEditPage({
      [`POST /api/units/${unitResponse().id}/archive`]: () =>
        json(unitResponse({ archivedAt: "2026-07-18T00:00:00.000Z" })),
    });
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(calls).toContain(`POST /api/units/${unitResponse().id}/archive`),
    );
  });

  // The bug the two-session review caught: a Unit under an ARCHIVED property must
  // read as archived (effective-archived, ADR-0005), not as a bookable room under
  // a "retired" banner. The whole section goes read-only history - no add, no
  // per-unit actions - because units come back by unarchiving the property.
  it("shows units as read-only history when the PROPERTY is archived", async () => {
    stubEditPage(
      {
        [`GET /api/properties/${propertyId}`]: () =>
          json(propertyResponse({ archivedAt: "2026-07-18T00:00:00.000Z" })),
      },
      // The unit's OWN flag is null - it's archived only by derivation.
      [unitResponse()],
    );
    renderAt(editUrl);

    expect(await screen.findByText("Garden Room 1")).toBeInTheDocument();
    // Effectively archived despite its own flag being null.
    expect(screen.getByText("Property archived")).toBeInTheDocument();
    // No per-unit actions and no add row while the property is retired.
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Delete$/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add unit" }),
    ).not.toBeInTheDocument();
  });
});
