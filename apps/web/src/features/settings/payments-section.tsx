import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  paymentEnvironmentSchema,
  savePaymentCredentialRequestSchema,
  type PaymentCredentialStatusResponse,
  type SavePaymentCredentialRequest,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { formatInstant } from "../../lib/date";
import { issuesToFieldErrors } from "../../lib/forms";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

/**
 * The Tenant's Midtrans credentials (REQ-PA-04, ADR-0039, page-spec §4.7
 * amendment). OWNER-ONLY in both directions - the page renders this section
 * only for owners, and the server 403s both routes for anyone else.
 *
 * WRITE-ONLY by design: the key the owner pastes here is never shown again, in
 * any form (no masking, no last-4 - that is partial readback). What renders is
 * that a key exists, when it was saved, and how the save-time verification
 * against Midtrans went. Losing the key means pasting it again from the
 * Midtrans dashboard - which is also the replace flow, the same form.
 */
export function PaymentsSection() {
  const query = useQuery({
    queryKey: ["payment-credentials"],
    queryFn: () =>
      api.get<PaymentCredentialStatusResponse[]>(
        "/settings/payment-credentials",
      ),
  });
  const credential = query.data?.find((c) => c.provider === "midtrans");

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">Payments</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Guests pay straight into your own Midtrans account - Sambung never holds
        your money. Paste your server key from the Midtrans dashboard (Settings
        → Access Keys). Until one is saved, your public pages show availability
        but tell guests to contact you instead of paying online.
      </p>

      {query.isError && (
        <p className="mt-3 text-sm text-muted-foreground">
          We couldn’t load your payment settings. Please try again.
        </p>
      )}
      {!query.data && !query.isError && (
        <div className="mt-4 h-16 animate-pulse rounded-md bg-muted/40" />
      )}
      {query.data && (
        <>
          <CredentialStatus credential={credential} />
          <CredentialForm configured={Boolean(credential)} />
        </>
      )}
    </div>
  );
}

function CredentialStatus({
  credential,
}: {
  credential: PaymentCredentialStatusResponse | undefined;
}) {
  if (!credential) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        No key saved yet - online checkout is off, everything else (walk-ins,
        calendar sync, your public page) keeps working.
      </p>
    );
  }
  const verify =
    credential.lastVerifyStatus === "ok"
      ? { label: "key checked ✓", className: "bg-success/10 text-success" }
      : credential.lastVerifyStatus === "failed"
        ? {
            label: "key check failed",
            className: "bg-destructive/10 text-destructive",
          }
        : { label: "unchecked", className: "bg-muted text-muted-foreground" };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium text-foreground">
        Midtrans · {credential.environment}
      </span>
      <span
        className={`rounded px-1.5 py-0.5 text-xs font-medium ${verify.className}`}
      >
        {verify.label}
      </span>
      <span className="text-muted-foreground">
        saved {formatInstant(credential.configuredAt)}
      </span>
      {credential.lastVerifyStatus === "failed" && (
        <p className="w-full text-xs text-destructive">
          The key didn’t verify against Midtrans ({credential.environment}) when
          it was saved - it may be for the other environment, mistyped, or
          Midtrans was unreachable. Guests can still be sent to checkout, but
          payments will fail until a working key is saved.
        </p>
      )}
    </div>
  );
}

function CredentialForm({ configured }: { configured: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ serverKey: "", environment: "sandbox" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: SavePaymentCredentialRequest) =>
      api.put<PaymentCredentialStatusResponse>(
        "/settings/payment-credentials/midtrans",
        body,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["payment-credentials"],
      });
      // Cleared on purpose: the key is write-only and must not linger in the
      // input for a shoulder-surf or the next screenshot.
      setForm((f) => ({ ...f, serverKey: "" }));
      setFieldErrors({});
    },
    onError: (error) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors : {});
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = savePaymentCredentialRequestSchema.safeParse({
      serverKey: form.serverKey,
      environment: form.environment,
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    save.mutate(parsed.data);
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 max-w-md space-y-4">
      <FormField
        label={configured ? "Replace server key" : "Server key"}
        type="password"
        autoComplete="off"
        placeholder="SB-Mid-server-…"
        value={form.serverKey}
        onChange={(e) =>
          setForm((f) => ({ ...f, serverKey: e.target.value }))
        }
        error={fieldErrors.serverKey}
      />
      <div>
        <label
          className="mb-1 block text-sm font-medium text-foreground"
          htmlFor="payment-environment"
        >
          Environment
        </label>
        <select
          id="payment-environment"
          value={form.environment}
          onChange={(e) =>
            setForm((f) => ({ ...f, environment: e.target.value }))
          }
          className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
        >
          {paymentEnvironmentSchema.options.map((env) => (
            <option key={env} value={env}>
              {env === "sandbox" ? "Sandbox (testing)" : "Production (live)"}
            </option>
          ))}
        </select>
      </div>
      <p className="text-sm text-muted-foreground">
        The key is checked against Midtrans and stored encrypted. It is never
        shown again - to change it, paste a new one.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : configured ? "Replace key" : "Save key"}
        </Button>
        {save.isSuccess && !save.isPending && (
          <span className="text-sm text-muted-foreground">
            Saved. Guests can now pay online.
          </span>
        )}
        {save.isError && Object.keys(fieldErrors).length === 0 && (
          <span className="text-sm text-destructive">
            Saving failed - please try again
          </span>
        )}
      </div>
    </form>
  );
}
