import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The a11y wiring FormField owns and hands to whatever control renders it: a
 * stable `id` (so the label's `htmlFor` points at it) plus the invalid/described
 * attributes. `aria-describedby` names the error only when there is one, so the
 * error is the input's accessible *description* - it appears and disappears while
 * the accessible *name* stays exactly the label text.
 */
type FieldControlProps = {
  id: string;
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
};

type FormFieldProps = Omit<ComponentProps<"input">, "id" | "children"> & {
  label: string;
  error?: string;
  id?: string;
  /**
   * A custom control - a textarea, or an input wrapped alongside something else.
   * Spread the given wiring onto the *focusable* element so the label and error
   * bind to it, not to a wrapper. Omit it for a plain text input, which
   * FormField renders itself from the remaining props.
   */
  children?: (control: FieldControlProps) => ReactNode;
};

/**
 * One label + control + error block for every form on the dashboard.
 *
 * The point is the wiring, not the markup it removes: the error lives in a
 * sibling `<p id>` referenced by `aria-describedby`, never inside the `<label>`.
 * An error inside the label folds into the input's accessible name ("Email"
 * becoming "Email Email already registered"), which is what screen readers
 * announce as the field's name and what forced tests onto prefix regexes. Here
 * the name is only ever the label text; the error is announced as a description.
 */
export function FormField({
  label,
  error,
  id,
  className,
  children,
  ...inputProps
}: FormFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const control: FieldControlProps = {
    id: fieldId,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errorId : undefined,
  };

  return (
    <div>
      <label
        htmlFor={fieldId}
        className="block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      {children ? (
        children(control)
      ) : (
        <input
          className={cn(
            "mt-1 w-full rounded-md border border-input px-3 py-2",
            className,
          )}
          {...control}
          {...inputProps}
        />
      )}
      {error && (
        <p id={errorId} className="mt-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
