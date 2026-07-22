import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  acceptInviteRequestSchema,
  type AuthResponse,
  type InvitePreviewResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { setSession } from "../../lib/auth";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { issuesToFieldErrors } from "../../lib/forms";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/wordmark";

/**
 * Accept a staff invite (`/invite/:token`, page-spec §3.4, #57).
 *
 * The one page in the app reached by a link from an email rather than by
 * navigation, so it has to answer "what is this?" before it asks for anything:
 * it previews who invited you and what you'll be able to manage, then takes a
 * password.
 *
 * The email is deliberately NOT an input. It is whatever the invite says - a
 * holder cannot redirect a seat to a different address - so it is shown, not
 * asked for.
 *
 * English only, like the dashboard (ADR-0024 gives three languages to the guest
 * funnel; this is an operator account page, and the invite email is English too).
 */
export function AcceptInvitePage() {
  const { token } = useParams({ from: "/invite/$token" });
  const preview = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.get<InvitePreviewResponse>(`/auth/invites/token/${token}`),
    retry: false,
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <Wordmark className="mb-8" />
      {preview.isLoading && (
        <div className="h-40 animate-pulse rounded-md bg-muted/40" />
      )}
      {preview.isError && <InviteProblem error={preview.error} />}
      {preview.data && <AcceptForm token={token} invite={preview.data} />}
    </main>
  );
}

/**
 * Why the link doesn't work. A 404 (unknown token) and a 409 (spent one) are
 * deliberately different answers from the API - only someone holding a real
 * invite is told which of expired/accepted/revoked applies - so the copy differs
 * too rather than collapsing both into "something went wrong".
 */
function InviteProblem({ error }: { error: unknown }) {
  const conflict = conflictOf(error);
  const message = conflict
    ? describeConflict(conflict)
    : "This invite link isn't valid. Check the link in your email, or ask the account owner to send a new one.";
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h1 className="text-lg font-semibold">This invite can't be used</h1>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      <Link
        to="/login"
        className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        Go to sign in
      </Link>
    </div>
  );
}

function AcceptForm({
  token,
  invite,
}: {
  token: string;
  invite: InvitePreviewResponse;
}) {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      api.post<AuthResponse>("/auth/invites/accept", body),
    onSuccess: (auth) => {
      // Accepting IS signing in - the API set the refresh cookie and handed back
      // an access token, exactly as login does. Straight to the dashboard.
      setSession(auth);
      void navigate({ to: "/app" });
    },
    onError: (error) => {
      const conflict = conflictOf(error);
      if (conflict) {
        setFormError(describeConflict(conflict));
      } else if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        if (Object.keys(error.fieldErrors).length === 0) {
          setFormError(error.message);
        }
      }
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = acceptInviteRequestSchema.safeParse({ token, password });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setFormError(null);
    accept.mutate(parsed.data);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h1 className="text-xl font-bold">Join {invite.tenantName}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        You've been invited as <strong>{invite.email}</strong>. Choose a password
        to set up your account.
      </p>

      {invite.propertyNames.length > 0 && (
        <div className="mt-4 rounded-md bg-muted/40 px-3 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            You'll be able to manage
          </p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {invite.propertyNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <FormField
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        {formError && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            {formError}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={accept.isPending}>
          {accept.isPending ? "Setting up…" : "Create account"}
        </Button>
      </form>
    </div>
  );
}
