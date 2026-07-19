import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FormField } from "./form-field";

afterEach(cleanup);

describe("FormField (#71)", () => {
  it("renders a labelled input reachable by its exact label", () => {
    render(<FormField label="Email" type="email" />);
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("type", "email");
  });

  it("forwards input props (value, onChange)", () => {
    const onChange = vi.fn();
    render(<FormField label="Email" value="a@b.dev" onChange={onChange} />);
    const input = screen.getByLabelText("Email");
    expect(input).toHaveValue("a@b.dev");
    fireEvent.change(input, { target: { value: "c@d.dev" } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("leaves the input unmarked and undescribed when there is no error", () => {
    render(<FormField label="Email" defaultValue="" />);
    const input = screen.getByLabelText("Email");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).toHaveAccessibleDescription("");
  });

  it("wires an error as a sibling description, keeping the accessible name stable", () => {
    render(<FormField label="Email" error="Email already registered" />);
    const input = screen.getByLabelText("Email");

    // The whole point of #71: the error is a *description*, not part of the
    // accessible *name* - so the field is still reachable as exactly "Email".
    expect(input).toHaveAccessibleName("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Email already registered");

    // The error is a sibling <p id> the input points at, never a child of the
    // <label>.
    const error = screen.getByText("Email already registered");
    expect(error.tagName).toBe("P");
    expect(error.closest("label")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("wires a custom control (render-prop) the same way", () => {
    render(
      <FormField label="Description" error="Too long">
        {(field) => <textarea {...field} />}
      </FormField>,
    );
    const textarea = screen.getByLabelText("Description");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveAccessibleName("Description");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveAccessibleDescription("Too long");
  });

  it("gives distinct fields distinct ids so their errors don't collide", () => {
    render(
      <>
        <FormField label="Email" error="bad email" />
        <FormField label="Password" error="bad password" />
      </>,
    );
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(email.getAttribute("aria-describedby")).not.toBe(
      password.getAttribute("aria-describedby"),
    );
    expect(email).toHaveAccessibleDescription("bad email");
    expect(password).toHaveAccessibleDescription("bad password");
  });
});
