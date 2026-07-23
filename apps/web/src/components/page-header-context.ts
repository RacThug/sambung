import { createContext } from "react";

/**
 * The top-bar page-header slot the dashboard shell provides and every
 * `<PageHeader>` portals into (ADR-0037 follow-up). Kept apart from the component
 * so this module exports no component and stays fast-refresh clean - the same
 * split the i18n layer keeps between `context.ts` and `provider.tsx`.
 */
export const PageHeaderSlotContext = createContext<HTMLElement | null>(null);
