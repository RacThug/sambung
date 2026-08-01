/**
 * The three states every dashboard list shows before it shows rows.
 *
 * Written because the audit behind `docs/pages/_list-pattern.md` found the app had
 * two answers to each of them and, on five lists, no answer at all to the third:
 * a failed read fell through to the EMPTY state, so `/app/properties` told an owner
 * whose network had blipped to "add your first property" (divergences D1, D2, D5).
 *
 * The decisions these encode, all recorded in `_list-pattern.md`:
 *
 *  - **Loading is a shaped block, never a line of text**, and never replaces the
 *    page header - the chrome is derived from the route, so blanking it spends a
 *    layout shift on something already known (D1).
 *  - **Error is checked BEFORE data** and is its own branch. "We could not ask" and
 *    "there is nothing" are different sentences, and conflating them is the one
 *    failure mode that makes a list actively lie (D5).
 *  - **The gate is `!data`, not `isLoading`** - `isLoading` goes false the moment a
 *    failed attempt settles, which is precisely how the fall-through happened (D2).
 *
 * Muted rather than destructive on the error: the semantic trio is for status, and
 * a transient read failure is not the same class of event as a refused action
 * (design-system §2, divergence D8).
 */
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

/** A region-sized placeholder. `rows` scales it to what it stands in for. */
export function ListSkeleton({ className = "h-40" }: { className?: string }) {
  return (
    <div
      className={`${className} animate-pulse rounded-lg border border-border bg-muted/40`}
      aria-hidden
    />
  );
}

/** The read failed. One sentence, the page around it still usable. */
export function ListError({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground"
    >
      {children}
    </p>
  );
}

/**
 * Render `children` only once the query has data, showing the error branch first
 * and the skeleton second.
 *
 * Takes the query rather than booleans so a call site cannot get the ORDER wrong,
 * which is the whole defect: every one of the five broken lists had the pieces and
 * checked them in the wrong sequence, or not at all.
 */
export function ListState<T>({
  query,
  errorText,
  skeleton = "h-40",
  children,
}: {
  query: Pick<UseQueryResult<T>, "data" | "isError">;
  errorText: string;
  skeleton?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isError) return <ListError>{errorText}</ListError>;
  if (query.data === undefined) return <ListSkeleton className={skeleton} />;
  return <>{children(query.data)}</>;
}
