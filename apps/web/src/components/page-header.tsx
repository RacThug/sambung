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
 * Why a portal, not a context-of-state set in an effect: the portal renders in the
 * SAME commit as the page (no empty-then-fills flicker) and unmounts with the page
 * (auto-cleanup on navigation). The dynamic-title case falls out for free - a
 * detail page passes `title={property.name}` straight from its fetched data.
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

  const content = (
    <div
      className={
        slot
          ? "flex min-w-0 flex-1 items-center gap-3"
          : "mb-4 flex items-center gap-3"
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-lg font-semibold text-foreground">
          {title}
        </h1>
        {titleSuffix}
      </div>
      {action && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>
      )}
    </div>
  );

  return slot ? createPortal(content, slot) : content;
}
