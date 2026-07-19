import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  registerRequestSchema,
  type AuthResponse,
  type RegisterRequest,
} from "@sambung/shared";
import { api } from "../../lib/api-client";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { setSession } from "../../lib/auth";
import { issuesToFieldErrors } from "../../lib/forms";
import { FormField } from "@/components/form-field";
import { Wordmark } from "@/components/wordmark";

const route = getRouteApi("/register");

// Signup creates the tenant + owner atomically and starts the session in one
// step - no second login (page-spec §3.4, FR-AUTH-1). Mirrors LoginPage:
// token to memory, then return to ?next or /app.
export function RegisterPage() {
  const navigate = useNavigate();
  const { next } = route.useSearch();
  const [tenantName, setTenantName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const register = useMutation({
    mutationFn: (body: RegisterRequest) =>
      api.post<AuthResponse>("/auth/register", body),
    onSuccess: (auth) => {
      setSession(auth);
      void navigate({ to: next ?? "/app" });
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = registerRequestSchema.safeParse({
      tenantName,
      email,
      password,
    });
    if (!parsed.success) {
      // A submit that never reaches the server must also retire the previous
      // server error - a stale 409 would misdescribe the retyped email.
      register.reset();
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    register.mutate(parsed.data);
  }

  // The only 409 register can raise is a taken email, and it belongs on the
  // email field (api-spec §3.1). We switch on the machine-readable slug, not the
  // bare status, and render our OWN copy (#82) - the server sends no prose here;
  // anything else gets a generic retry line.
  const conflict = conflictOf(register.error);
  const emailError =
    conflict?.code === "email_taken"
      ? describeConflict(conflict)
      : fieldErrors.email;
  const submitError =
    register.error && !conflict
      ? "Something went wrong - please try again"
      : null;

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1>
        <Wordmark className="text-2xl" />
      </h1>
      <p className="mt-1 text-muted-foreground">Create your owner account</p>

      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <FormField
          label="Business name"
          type="text"
          autoComplete="organization"
          value={tenantName}
          onChange={(e) => setTenantName(e.target.value)}
          error={fieldErrors.tenantName}
        />

        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={emailError}
        />

        <FormField
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />

        {submitError && (
          <p className="text-sm text-destructive">{submitError}</p>
        )}

        <button
          type="submit"
          disabled={register.isPending}
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
        >
          {register.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="mt-4 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/login" search={{ next }} className="text-primary underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
