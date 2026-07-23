import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { PageHeader } from "./page-header";
import { PageHeaderSlotContext } from "./page-header-context";

afterEach(cleanup);

describe("PageHeader", () => {
  it("portals the title + action into the provided slot", () => {
    // Mirrors the shell: a header element published to the context via a ref,
    // with the page rendered under the provider.
    function Harness() {
      const [slot, setSlot] = useState<HTMLElement | null>(null);
      return (
        <div>
          <header data-testid="bar" ref={setSlot} />
          <PageHeaderSlotContext.Provider value={slot}>
            <main data-testid="content">
              <PageHeader
                title="Properties"
                action={<button type="button">New property</button>}
              />
            </main>
          </PageHeaderSlotContext.Provider>
        </div>
      );
    }
    render(<Harness />);

    const bar = screen.getByTestId("bar");
    expect(
      within(bar).getByRole("heading", { name: "Properties" }),
    ).toBeInTheDocument();
    expect(
      within(bar).getByRole("button", { name: "New property" }),
    ).toBeInTheDocument();

    // It portaled OUT of the content area, not rendered in place.
    expect(
      within(screen.getByTestId("content")).queryByRole("heading"),
    ).not.toBeInTheDocument();
  });

  it("renders inline when there is no slot (graceful fallback)", () => {
    // No provider - a page rendered on its own still shows its heading rather
    // than vanishing (keeps isolated page tests working, and covers the frame
    // before the shell's slot ref attaches).
    render(<PageHeader title="Settings" />);
    expect(
      screen.getByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
  });
});
