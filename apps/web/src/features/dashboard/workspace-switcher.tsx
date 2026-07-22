import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AuthResponse } from "@sambung/shared";
import { api } from "../../lib/api-client";
import { setSession } from "../../lib/auth";
import { useSession } from "../../lib/use-session";

/**
 * The workspace switcher (#154, ADR-0034).
 *
 * Renders the tenant name alone for the ordinary case - one seat, nothing to
 * switch between - and a select only when the account actually holds more than
 * one. A control that never has a second option is chrome pretending to be a
 * feature.
 *
 * Switching REPLACES the session and then resets the whole query cache: every
 * cached list belongs to the tenant it was fetched under, and showing one
 * tenant's calendar under another tenant's name for even one frame is the
 * failure this component exists to avoid.
 */
export function WorkspaceSwitcher() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);

  if (!session) return null;

  const { memberships, tenant } = session;
  if (memberships.length < 2) {
    return (
      <span className="text-sm text-muted-foreground">{tenant.name}</span>
    );
  }

  async function switchTo(tenantId: string) {
    if (tenantId === tenant.id || switching) return;
    setSwitching(true);
    try {
      const auth = await api.post<AuthResponse>("/auth/session", { tenantId });
      setSession(auth);
      // Nothing cached is valid in the new tenant. `reset` rather than
      // `invalidate`, because an invalidated query keeps RENDERING its stale
      // data while it refetches - one tenant's reservations under another
      // tenant's name, which is the exact failure this must not have. Reset
      // drops the data (so the page shows its loading state) and refetches
      // whatever is on screen.
      await queryClient.resetQueries();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="sr-only">Workspace</span>
      <select
        value={tenant.id}
        disabled={switching}
        onChange={(e) => void switchTo(e.target.value)}
        className="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground disabled:opacity-60"
      >
        {memberships.map((m) => (
          <option key={m.tenantId} value={m.tenantId}>
            {m.tenantName}
          </option>
        ))}
      </select>
    </label>
  );
}
