import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
  json,
  propertyResponse as property,
  renderAt,
  stubFetch,
} from "../../test-utils";

beforeEach(() => {
  setSession(authResponse());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

describe("properties list (§4.4)", () => {
  it("renders each property with its verified badge and publishable state", async () => {
    stubFetch({
      "GET /api/properties": () =>
        json([
          property({
            id: "aaaaaaaa-0000-0000-0000-000000000001",
            name: "Licensed Villa",
            verified: true,
            publishable: true,
          }),
          property({
            id: "aaaaaaaa-0000-0000-0000-000000000002",
            name: "Unlicensed Villa",
          }),
        ]),
    });
    renderAt("/app/properties");

    expect(await screen.findByText("Licensed Villa")).toBeInTheDocument();
    expect(screen.getByText("Unlicensed Villa")).toBeInTheDocument();
    // Exactly one of the two is verified / publishable.
    expect(screen.getAllByText(/Verified/)).toHaveLength(1);
    expect(screen.getAllByText(/Ready to publish/)).toHaveLength(1);
    expect(screen.getAllByText(/Incomplete/)).toHaveLength(1);
  });

  // Archive (ADR-0006, #84): a retired property is shown distinctly, and its
  // retirement trumps the publish checklist - it's offline for guests regardless
  // of how complete it is.
  it("shows an archived property distinctly, not its publishable state", async () => {
    stubFetch({
      "GET /api/properties": () =>
        json([
          property({
            id: "aaaaaaaa-0000-0000-0000-000000000003",
            name: "Retired Villa",
            publishable: true,
            archivedAt: "2026-07-18T00:00:00.000Z",
          }),
        ]),
    });
    renderAt("/app/properties");

    expect(await screen.findByText("Retired Villa")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByText(/hidden from guests/i)).toBeInTheDocument();
    // Even though publishable is true, "Ready to publish" must not show.
    expect(screen.queryByText(/Ready to publish/)).not.toBeInTheDocument();
  });

  it("maps create-dialog validation errors to the name field without calling the API", async () => {
    const calls = stubFetch({
      "GET /api/properties": () => json([]),
    });
    renderAt("/app/properties");

    fireEvent.click(await screen.findByRole("button", { name: "New property" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(/at least 2 character/i),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });

  it("creates a property and navigates to its edit page", async () => {
    const created = property({ name: "Fresh Villa" });
    stubFetch({
      "GET /api/properties": () => json([]),
      "POST /api/properties": () => json(created, 201),
      [`GET /api/properties/${created.id}`]: () => json(created),
    });
    const router = renderAt("/app/properties");

    fireEvent.click(await screen.findByRole("button", { name: "New property" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Fresh Villa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Details")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/app/properties/${created.id}`,
    );
  });
});

describe("property edit (§4.5 details tab)", () => {
  /**
   * The slug is minted server-side, so this link is the ONLY way an owner
   * learns the address of their own page. Without it, "a guest opens a shared
   * link" has no first step (#46).
   */
  it("shows the public URL so the owner can actually share it", async () => {
    const row = property({ slug: "seminyak-beach-villa" });
    stubFetch({ [`GET /api/properties/${row.id}`]: () => json(row) });
    renderAt(`/app/properties/${row.id}`);

    const link = await screen.findByRole("link", { name: /\/p\/seminyak-beach-villa$/ });
    expect(link).toHaveAttribute("href", "/p/seminyak-beach-villa");
  });

  it("calls an incomplete page live-but-incomplete, not unpublished", async () => {
    // publishable never gates the page (ADR-0004), so the copy must not imply a
    // publish step that doesn't exist.
    const row = property({ publishable: false });
    stubFetch({ [`GET /api/properties/${row.id}`]: () => json(row) });
    renderAt(`/app/properties/${row.id}`);

    expect(
      await screen.findByText(/public page is live, but incomplete/i),
    ).toBeInTheDocument();
  });

  /**
   * The zone is a fact about WHERE the property is (#145, ADR-0028), so it is
   * rendered in the location group - after the coordinates, before Description -
   * and NOT down with the payment settings, which is where it first landed.
   *
   * That placement is the whole reason the WITA default is honest rather than a
   * guess: an owner sees it while stating where the villa is. So the ORDER is the
   * decision, and pinning it here is what stops it quietly drifting back down the
   * form, taking the justification for the default with it.
   */
  it("puts the time zone in the location group, not with the payment settings", async () => {
    const row = property({ timeZone: "Asia/Jayapura" });
    stubFetch({ [`GET /api/properties/${row.id}`]: () => json(row) });
    renderAt(`/app/properties/${row.id}`);

    const zone = await screen.findByLabelText(/time zone/i);
    expect(zone).toHaveValue("Asia/Jayapura");

    // Ordered against its neighbours rather than by index, so adding an
    // unrelated field between them doesn't fail this for the wrong reason.
    const longitude = screen.getByLabelText(/longitude/i);
    const description = screen.getByLabelText(/description/i);
    expect(longitude.compareDocumentPosition(zone)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(description.compareDocumentPosition(zone)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );

    // The copy leads with the place; the OTA feed is the consequence, not the
    // framing - an owner filling in an address must recognise this as the same
    // question, or they will skip it.
    expect(
      screen.getByText(/local clock where the property is/i),
    ).toBeInTheDocument();
  });

  it("previews the Verified badge live while typing a license number", async () => {
    const row = property({});
    stubFetch({
      [`GET /api/properties/${row.id}`]: () => json(row),
    });
    renderAt(`/app/properties/${row.id}`);

    expect(await screen.findByText("Details")).toBeInTheDocument();
    expect(screen.queryByText(/Verified/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("License number (NIB)"), {
      target: { value: "NIB-123" },
    });
    expect(screen.getByText(/Verified/)).toBeInTheDocument();
  });

  it("renders the 409 reason when delete is blocked by bookings", async () => {
    const row = property({});
    vi.spyOn(window, "confirm").mockReturnValue(true);
    stubFetch({
      [`GET /api/properties/${row.id}`]: () => json(row),
      [`DELETE /api/properties/${row.id}`]: () =>
        // #82: the 409 carries the count as data (code + count); the web composes
        // the sentence, so no stale server prose ("cancel them first") can leak.
        json(
          {
            statusCode: 409,
            error: "Conflict",
            code: "property_has_bookings",
            count: 2,
            message: "Property has 2 booking(s); archive it instead of deleting",
          },
          409,
        ),
    });
    renderAt(`/app/properties/${row.id}`);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete property" }),
    );
    expect(
      await screen.findByText(/this property has 2 bookings/i),
    ).toBeInTheDocument();
  });

  it("deletes an unblocked property and returns to the list", async () => {
    const row = property({});
    vi.spyOn(window, "confirm").mockReturnValue(true);
    stubFetch({
      [`GET /api/properties/${row.id}`]: () => json(row),
      [`DELETE /api/properties/${row.id}`]: () =>
        new Response(null, { status: 204 }),
      "GET /api/properties": () => json([]),
    });
    const router = renderAt(`/app/properties/${row.id}`);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete property" }),
    );
    expect(
      await screen.findByText("Add your first property"),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/app/properties");
  });
});
