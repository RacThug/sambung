import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { loginRequestSchema, type AuthResponse } from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { setSession } from "../../lib/auth";
import { issuesToFieldErrors } from "../../lib/forms";
import { FormField } from "@/components/form-field";
import { Wordmark } from "@/components/wordmark";
import { useI18n } from "@/i18n/context";

const route = getRouteApi("/login");

// Owner session start (page-spec §3.4). On success the access token goes to
// memory and we return to ?next (the URL the auth guard bounced from) or /app.
export function LoginPage() {
  const navigate = useNavigate();
  const { next } = route.useSearch();
  const { t } = useI18n();
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
      // A submit that never reaches the server must also retire the previous
      // server error - a stale 401 would outlive the corrected input.
      login.reset();
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    login.mutate(parsed.data);
  }

  // 401 is "wrong email or password" - never say which (no account oracle).
  //
  // 403 is a DIFFERENT answer and needs different words: the password was correct
  // and the account holds no memberships, because every seat was removed (api-spec
  // §3.2). It is not an oracle - only a correct password reaches it - and the whole
  // reason the API distinguishes it is so the person is not sent to reset a
  // password that already works. Until now the page collapsed it into the generic
  // line and threw that distinction away.
  const status = login.error instanceof ApiError ? login.error.status : null;
  const submitError =
    status === 401
      ? t("auth.invalidCredentials")
      : status === 403
        ? t("auth.noWorkspace")
        : login.error
          ? t("auth.genericError")
          : null;

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1>
        <Wordmark className="text-2xl" />
      </h1>
      <p className="mt-1 text-muted-foreground">{t("auth.signInSubtitle")}</p>

      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <FormField
          label={t("auth.email")}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
        />

        <FormField
          label={t("auth.password")}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />

        {submitError && (
          <p className="text-sm text-destructive">{submitError}</p>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
        >
          {login.isPending ? t("auth.signingIn") : t("auth.signIn")}
        </button>
      </form>

      <p className="mt-4 text-sm text-muted-foreground">
        {t("auth.newToSambung")}{" "}
        <Link to="/register" search={{ next }} className="text-primary underline">
          {t("auth.createAccount")}
        </Link>
      </p>
    </main>
  );
}
