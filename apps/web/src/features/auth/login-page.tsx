import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { loginRequestSchema, type AuthResponse } from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { setSession } from "../../lib/auth";

const route = getRouteApi("/login");

// Owner session start (page-spec §3.4). On success the access token goes to
// memory and we return to ?next (the URL the auth guard bounced from) or /app.
export function LoginPage() {
  const navigate = useNavigate();
  const { next } = route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const login = useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api.post<AuthResponse>("/auth/login", body),
    onSuccess: (auth) => {
      setSession(auth);
      void navigate({ to: next ?? "/app" });
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errors[issue.path.join(".")] ??= issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    login.mutate(parsed.data);
  }

  // 401 is "wrong email or password" - never say which (no account oracle).
  const submitError =
    login.error instanceof ApiError && login.error.status === 401
      ? "Invalid email or password"
      : login.error
        ? "Something went wrong - please try again"
        : null;

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-bold text-brand-600">Sambung</h1>
      <p className="mt-1 text-gray-600">Sign in to your dashboard</p>

      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Email</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
          {fieldErrors.email && (
            <p className="mt-1 text-sm text-red-600">{fieldErrors.email}</p>
          )}
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Password</span>
          <input
            type="password"
            autoComplete="current-password"
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
          disabled={login.isPending}
          className="w-full rounded-md bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
