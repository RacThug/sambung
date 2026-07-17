import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  registerRequestSchema,
  type AuthResponse,
  type RegisterRequest,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { setSession } from "../../lib/auth";
import { issuesToFieldErrors } from "../../lib/forms";

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
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    register.mutate(parsed.data);
  }

  // 409 = duplicate email, so it belongs on the email field (api-spec §3.1);
  // anything else gets a generic retry line.
  const emailTaken =
    register.error instanceof ApiError && register.error.status === 409;
  const emailError = emailTaken
    ? "Email already registered"
    : fieldErrors.email;
  const submitError =
    register.error && !emailTaken
      ? "Something went wrong - please try again"
      : null;

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-bold text-brand-600">Sambung</h1>
      <p className="mt-1 text-gray-600">Create your owner account</p>

      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            Business name
          </span>
          <input
            type="text"
            autoComplete="organization"
            value={tenantName}
            onChange={(e) => setTenantName(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
          {fieldErrors.tenantName && (
            <p className="mt-1 text-sm text-red-600">{fieldErrors.tenantName}</p>
          )}
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Email</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
          {emailError && (
            <p className="mt-1 text-sm text-red-600">{emailError}</p>
          )}
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
          {fieldErrors.password && (
            <p className="mt-1 text-sm text-red-600">{fieldErrors.password}</p>
          )}
        </label>

        {submitError && <p className="text-sm text-red-600">{submitError}</p>}

        <button
          type="submit"
          disabled={register.isPending}
          className="w-full rounded-md bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {register.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="mt-4 text-sm text-gray-600">
        Already have an account?{" "}
        <Link to="/login" search={{ next }} className="text-brand-600 underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
