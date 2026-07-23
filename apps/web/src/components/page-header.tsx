import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageHeaderSlotContext } from "./page-header-context";

/**
 * The top-bar page header (ADR-0037 follow-up). The dashboard shell renders an
 * empty container in its top bar and hands it down through `PageHeaderSlotContext`;
 * each page declares its heading + optional primary action with `<PageHeader>`,
 * which PORTALS into that container - so the title/action sit in the top bar
 * without any page importing the shell's markup.
 *
 * Why a portal, not a context-of-state set in an effect: on navigation the slot
 * already exists, so a page's title portals in its FIRST commit - no
 * empty-then-fills flash - and unmounts with the page (auto-cleanup). An
 * effect-based header would publish the slot AFTER paint, flashing inline then
 * jumping to the top bar. (On the very first dashboard mount the shell's ref
 * callback publishes the slot during commit, so even then the portal lands before
 * the browser paints.) The dynamic-title case falls out for free - a detail page
 * passes `title={property.name}` straight from its fetched data.
 *
 * Graceful fallback: with no slot in context - a page rendered on its own (a unit
 * test), or the brief moment before the shell's slot ref is attached - it renders
 * the header INLINE at its call site rather than vanishing.
 */
export function PageHeader({
  title,
  titleSuffix,
  action,
}: {
  title: string;
  /** Rendered next to the title (e.g. a Verified/Archived badge on a detail page). */
  titleSuffix?: ReactNode;
  /** The page's one primary action (e.g. "New property", "Export CSV"). */
  action?: ReactNode;
}) {
  const slot = useContext(PageHeaderSlotContext);

  const inner = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-lg font-semibold text-foreground">
          {title}
        </h1>
        {titleSuffix}
      </div>
      {action && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>
      )}
    </>
  );

  // The shell's slot div OWNS the flex layout (so it lives in one place, not
  // duplicated here). With no slot - an isolated render, or the first-mount frame
  // before the shell's ref callback publishes it - wrap the same content in a
  // plain inline header instead of vanishing.
  return slot ? (
    createPortal(inner, slot)
  ) : (
    <div className="mb-4 flex items-center gap-3">{inner}</div>
  );
}
