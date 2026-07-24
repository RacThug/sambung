import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  channelSchema,
  createChannelConnectionRequestSchema,
  isArchived,
  type Channel,
  type ChannelConnectionResponse,
  type CreateChannelConnectionRequest,
  type DisconnectChannelResponse,
  type PropertyResponse,
  type SyncConnectionResponse,
  type SyncStatus,
  type UnitResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { issuesToFieldErrors } from "../../lib/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Channels on the property workbench (page-spec §4.5, api #28/#29/#30/#34, #55).
 *
 * Sync is per-Unit, because a Unit is one sellable thing (ADR-0001) with its own
 * OTA calendar. So this is one panel per Unit: its export .ics link to paste OUT
 * to the OTAs, plus the connections that pull their bookings IN.
 *
 * Here we connect, list status, disconnect, and hand over the export URL. Sync
 * CONFLICTS get a count badge per connection (#38) but are acted on in the inbox
 * (`/app/inbox`) - one conflict is about two bookings across two systems, which is
 * a reconciliation task rather than a property-settings one.
 */
export function ChannelsSection({ property }: { property: PropertyResponse }) {
  // Same query key as UnitsSection - TanStack Query dedupes, so this doesn't
  // double-fetch the units already loaded above.
  const { data: units, isLoading } = useQuery({
    queryKey: ["properties", property.id, "units"],
    queryFn: () => api.get<UnitResponse[]>(`/properties/${property.id}/units`),
  });
  const propertyArchived = isArchived(property);

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">Channels</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Keep OTA calendars in sync. Paste each unit's export link into Airbnb,
        Booking.com or Vrbo so they stop selling nights booked here.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading channels…</p>
      ) : !units || units.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Add a unit first - channels are connected per unit.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {units.map((unit) => (
            <UnitChannels
              key={unit.id}
              unit={unit}
              propertyArchived={propertyArchived}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const CHANNEL_LABELS: Record<Channel, string> = {
  airbnb: "Airbnb",
  booking_com: "Booking.com",
  vrbo: "Vrbo",
};

function UnitChannels({
  unit,
  propertyArchived,
}: {
  unit: UnitResponse;
  propertyArchived: boolean;
}) {
  // A self-archived unit under a live property, or any unit under an archived
  // property, is effectively archived (ADR-0005): no new connections, but the
  // export link stays live because the feed itself is archive-blind (ADR-0016) -
  // an OTA that already subscribed must keep being told these nights are busy.
  const effectiveArchived = isArchived(unit) || propertyArchived;

  const { data: connections, isLoading } = useQuery({
    queryKey: ["units", unit.id, "channels"],
    queryFn: () =>
      api.get<ChannelConnectionResponse[]>(`/units/${unit.id}/channels`),
  });

  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">{unit.name}</h3>
        {effectiveArchived && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            Archived
          </span>
        )}
      </div>

      <ExportUrl unitId={unit.id} />

      {isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {connections?.map((conn) => (
            <ConnectionRow
              key={conn.id}
              conn={conn}
              unitId={unit.id}
              unitName={unit.name}
              readOnly={effectiveArchived}
            />
          ))}
        </ul>
      )}

      {effectiveArchived ? (
        <p className="mt-3 text-sm text-muted-foreground">
          This unit is archived - unarchive it to connect new channels.
        </p>
      ) : (
        <ConnectForm unitId={unit.id} connections={connections ?? []} />
      )}
    </div>
  );
}

/**
 * The export .ics URL an owner pastes into the OTA (page-spec §4.5, flow 4.1
 * step 5). The unguessable unit UUID is the address AND the access control
 * (ADR-0016), so the link works with no auth - exactly what an OTA's "import
 * calendar" box needs.
 */
function ExportUrl({ unitId }: { unitId: string }) {
  const [copied, setCopied] = useState(false);
  // Same-origin `/api` (Caddy proxies it in prod, the Vite dev server in dev),
  // so an absolute URL from the current origin is what the OTA should fetch.
  const url = `${window.location.origin}/api/public/units/${unitId}/calendar.ics`;

  return (
    <div className="mt-2 rounded-md bg-muted/50 p-3">
      <p className="text-xs font-medium text-muted-foreground">
        Export calendar (paste into the OTA's “import calendar” setting)
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="break-all text-xs text-foreground">{url}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<SyncStatus, { label: string; className: string }> = {
  never: {
    label: "Not synced yet",
    className: "bg-muted text-muted-foreground",
  },
  ok: { label: "Synced", className: "bg-success/10 text-success" },
  error: { label: "Sync error", className: "bg-destructive/10 text-destructive" },
};

function ConnectionRow({
  conn,
  unitId,
  unitName,
  readOnly,
}: {
  conn: ChannelConnectionResponse;
  unitId: string;
  unitName: string;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [kept, setKept] = useState<number | null>(null);

  /**
   * "Sync now" for THIS feed (#201). The calendar has a button that sweeps every
   * feed at once; this one exists because when a feed is erroring, the owner is
   * already here reading `lastError` and needs to retry the one they just fixed -
   * and the answer they need ("still unreachable") is per-feed, not a total.
   *
   * Invalidates the connection list (its `lastStatus`/`lastSyncedAt` just moved)
   * plus bookings and conflicts, the two things a successful pull can change.
   */
  const sync = useMutation({
    mutationFn: () =>
      api.post<SyncConnectionResponse>(`/channels/${conn.id}/sync`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["units", unitId, "channels"],
        }),
        queryClient.invalidateQueries({ queryKey: ["bookings"] }),
        queryClient.invalidateQueries({ queryKey: ["sync-conflicts"] }),
      ]);
    },
  });

  const disconnect = useMutation({
    mutationFn: () =>
      api.delete<DisconnectChannelResponse>(`/channels/${conn.id}`),
    onSuccess: (res) => {
      // Imported bookings are KEPT, never auto-cancelled (api-spec §7.4). Surface
      // how many remain so the owner can clean up deliberately (#82: from data).
      setKept(res.importedBookingsKept);
      void queryClient.invalidateQueries({ queryKey: ["units", unitId, "channels"] });
    },
  });

  const status = STATUS_STYLES[conn.lastStatus];

  return (
    <li className="rounded-md border border-border/60 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {CHANNEL_LABELS[conn.channel]}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${status.className}`}
          >
            {status.label}
          </span>
          {/* Open sync conflicts (#38): nights this feed sold that Sambung already
              had booked. Its own badge rather than folded into lastStatus, because
              the feed is HEALTHY - it downloaded and parsed fine, and most of it
              imported. Only what clashed is stuck, and that needs a human, not a
              retry. Links to the inbox where they can act on it. */}
          {conn.openConflicts > 0 && (
            <Link
              to="/app/inbox"
              className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/20"
            >
              {conn.openConflicts} conflict
              {conn.openConflicts === 1 ? "" : "s"}
            </Link>
          )}
        </div>
        {!readOnly && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              {sync.isPending ? "Syncing…" : "Sync now"}
            </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10"
            disabled={disconnect.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Disconnect ${CHANNEL_LABELS[conn.channel]} from “${unitName}”? Imported bookings are kept.`,
                )
              ) {
                disconnect.mutate();
              }
            }}
          >
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
          </div>
        )}
      </div>
      <p className="mt-1 break-all text-xs text-muted-foreground">
        {conn.importIcalUrl}
      </p>
      {conn.lastStatus === "error" && conn.lastError && (
        <p className="mt-1 text-xs text-destructive">{conn.lastError}</p>
      )}
      {kept !== null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Disconnected. {kept} imported {kept === 1 ? "booking" : "bookings"}{" "}
          kept.
        </p>
      )}
      {disconnect.isError && (
        <p className="mt-1 text-xs text-destructive">
          Disconnect failed - please try again.
        </p>
      )}
      {/* What THIS pull did. A healthy feed with 0 imported is the common case and
          says so, rather than leaving the owner unsure the click landed. The
          badge above carries the health; this line carries the outcome. */}
      {sync.isSuccess && sync.data && (
        <p className="mt-1 text-xs text-muted-foreground">
          Synced. {sync.data.imported} imported
          {sync.data.cancelled > 0 && `, ${sync.data.cancelled} cancelled`}
          {sync.data.conflicts > 0 && `, ${sync.data.conflicts} clashed`}.
        </p>
      )}
      {sync.isError && (
        <p className="mt-1 text-xs text-destructive">
          Sync failed - please try again.
        </p>
      )}
    </li>
  );
}

function ConnectForm({
  unitId,
  connections,
}: {
  unitId: string;
  connections: ChannelConnectionResponse[];
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ channel: "airbnb", importIcalUrl: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const connect = useMutation({
    mutationFn: (body: CreateChannelConnectionRequest) =>
      api.post<ChannelConnectionResponse>(`/units/${unitId}/channels`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["units", unitId, "channels"],
      });
      setForm({ channel: "airbnb", importIcalUrl: "" });
      setFieldErrors({});
    },
    onError: (error) => {
      // A duplicate (unit, channel) is the only 409 this form raises; render our
      // own copy from the slug, never the server's prose (#82). Otherwise surface
      // zod field errors.
      const conflict = conflictOf(error);
      setFieldErrors(
        conflict?.code === "channel_already_connected"
          ? { channel: describeConflict(conflict) }
          : error instanceof ApiError
            ? error.fieldErrors
            : {},
      );
    },
  });

  // Which channels are already connected - a Unit gets one feed per OTA (the
  // unique constraint), so an already-connected channel is disabled in the select
  // rather than offered and 409'd.
  const taken = new Set(connections.map((c) => c.channel));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = createChannelConnectionRequestSchema.safeParse({
      channel: form.channel,
      importIcalUrl: form.importIcalUrl,
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    connect.mutate(parsed.data);
  }

  const formError =
    connect.error instanceof ApiError &&
    connect.error.status !== 409 &&
    Object.keys(connect.error.fieldErrors).length === 0
      ? connect.error.message
      : connect.error && !(connect.error instanceof ApiError)
        ? "Something went wrong - please try again"
        : null;

  return (
    <form onSubmit={onSubmit} noValidate className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-start gap-2">
        <div>
          <label className="sr-only" htmlFor={`channel-${unitId}`}>
            Channel
          </label>
          <select
            id={`channel-${unitId}`}
            aria-label="Channel"
            value={form.channel}
            onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value }))}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {channelSchema.options.map((ch) => (
              <option key={ch} value={ch} disabled={taken.has(ch)}>
                {CHANNEL_LABELS[ch]}
                {taken.has(ch) ? " (connected)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[16rem] flex-1">
          <label className="sr-only" htmlFor={`ical-${unitId}`}>
            iCal URL
          </label>
          <Input
            id={`ical-${unitId}`}
            aria-label="iCal URL"
            value={form.importIcalUrl}
            onChange={(e) =>
              setForm((f) => ({ ...f, importIcalUrl: e.target.value }))
            }
            placeholder="https://www.airbnb.com/calendar/ical/…"
          />
        </div>
        <Button type="submit" size="sm" disabled={connect.isPending}>
          {connect.isPending ? "Connecting…" : "Connect"}
        </Button>
      </div>
      {(fieldErrors.channel || fieldErrors.importIcalUrl || formError) && (
        <p className="mt-2 text-xs text-destructive">
          {fieldErrors.channel ?? fieldErrors.importIcalUrl ?? formError}
        </p>
      )}
    </form>
  );
}
