import { useEffect, useState } from "react";
import {
  updateTenantSettingsRequestSchema,
  type TenantSettingsResponse,
} from "@sambung/shared";
import { ApiError } from "../../lib/api-client";
import { issuesToFieldErrors } from "../../lib/forms";
import { isOwner } from "../../lib/role";
import { TeamSection } from "../staff/team-section";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { useSettings, useUpdateSettings } from "./use-settings";

/**
 * Tenant settings (page-spec §4.7, #67). One knob today - how many photos a
 * property's gallery may hold - and the page #57 will hang staff/Team settings
 * on.
 *
 * Writes are owner-only. The server is the authority (`@Roles('owner')`); this
 * page reads the session role only to show staff a read-only view instead of a
 * form that would 403 on submit.
 */
export function SettingsPage() {
  const query = useSettings();
  const owner = isOwner();

  return (
    <section>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Preferences that apply across every property in your account.
      </p>

      <div className="mt-6 rounded-lg border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">Photos</h2>
        {query.isError && (
          <p className="mt-2 text-sm text-destructive">
            We couldn’t load your settings. Please try again.
          </p>
        )}
        {!query.data && !query.isError && (
          <div className="mt-4 h-20 animate-pulse rounded-md bg-muted/40" />
        )}
        {query.data &&
          (owner ? (
            <GalleryCapForm settings={query.data} />
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Each property can hold up to {query.data.galleryCap} photos. Only
              an account owner can change this.
            </p>
          ))}
      </div>

      {/* Team (#57). Owner-only - a staff member gets the same read-only
          treatment as the gallery cap above, for the same reason: the server
          answers 403, and a form that can only fail is worse than a sentence
          explaining why it isn't there. */}
      {owner ? (
        <TeamSection />
      ) : (
        <div className="mt-6 rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">Team</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Only an account owner can invite staff or change who can see which
            properties.
          </p>
        </div>
      )}
    </section>
  );
}

function GalleryCapForm({ settings }: { settings: TenantSettingsResponse }) {
  const save = useUpdateSettings();
  const [value, setValue] = useState(settings.galleryCap.toString());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Keep the input in step with the server's answer after a save (and if another
  // tab changed it), without stranding what the owner is currently typing.
  useEffect(() => {
    setValue(settings.galleryCap.toString());
  }, [settings.galleryCap]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = updateTenantSettingsRequestSchema.safeParse({
      galleryCap: value === "" ? Number.NaN : Number(value),
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    save.mutate(parsed.data, {
      onError: (error) => {
        if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      },
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 max-w-sm space-y-4">
      <FormField
        label="Photos per property"
        type="number"
        min={1}
        max={settings.galleryCeiling}
        step={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={fieldErrors.galleryCap}
      />
      <p className="text-sm text-muted-foreground">
        Between 1 and {settings.galleryCeiling}. Lowering this never deletes
        photos - a gallery that is already above the new limit stays as it is,
        and you simply can’t add more until you remove some.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {save.isSuccess && !save.isPending && (
          <span className="text-sm text-muted-foreground">Saved</span>
        )}
        {save.isError && !fieldErrors.galleryCap && (
          <span className="text-sm text-destructive">
            {save.error instanceof ApiError
              ? save.error.message
              : "Saving failed - please try again"}
          </span>
        )}
      </div>
    </form>
  );
}
