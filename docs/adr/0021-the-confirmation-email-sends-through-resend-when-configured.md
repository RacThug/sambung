# ADR-0021: The confirmation email sends through Resend when configured, else logs

- **Status:** Accepted
- **Date:** 2026-07-20
- **Issue:** #119 (M3; FR-NOTIF-1, api-spec §6.2 step 3) — follow-up from #53/#54
- **Relates:** ADR-0020 (built the `Mailer` seam this fills in), ADR-0018 (the webhook whose post-commit seam calls it), ADR-0015 (the `PaymentGateway` port whose no-SDK/`fetch` shape and env discipline this mirrors)

## Context

#54 (ADR-0020) built the whole confirmation-email seam: a `Mailer` port, a
`LogMailer` that RENDERS + logs the message (no credentials, no cost), a pure
`renderConfirmationEmail` template (guest + owner), and a best-effort
`NotificationsService` the payment webhook calls post-commit — fired **only** on the
status-guarded confirm that flips a row, so it is once-per-confirmation by
construction, and a send failure is caught and never rethrown (a bounced email must
not undo a confirmed booking or fail the webhook the provider is retrying).

ADR-0020 deliberately left the real provider as a follow-up: "a real email provider
now needs credentials and a recurring cost (invariant #8); the port + `LogMailer` is
a real, unit-testable seam today; the provider is a follow-up swap, not a shape
change." This ADR is that swap.

Constraint: **no paid third-party services** (invariant #8) — Resend's free tier or
plain SMTP only. Credentials cannot be obtained in the build environment, so the
adapter must be implemented and tested against a mocked transport; the real send is
verified at deploy.

## Decision

**A `ResendMailer` adapter sends over the Resend HTTP API with native `fetch`, and
`MAILER` is bound by a factory that picks it only when configured — otherwise the
zero-cost `LogMailer`.**

- `ResendMailer` POSTs `{ from, to, subject, text, html? }` to Resend with a
  `Bearer` key, an 8s timeout, and REJECTS on any failure (non-2xx, network,
  unconfigured). No SDK — a single authenticated POST needs none, and staying
  dependency-light keeps the adapter replaceable by the test fake. This mirrors
  `MidtransGateway` (ADR-0015) exactly: `ConfigService`, keys read at CALL time,
  `AbortSignal.timeout`, `fetch`.
- `createMailer(config)` returns `ResendMailer` **iff** `RESEND_API_KEY` **and**
  `MAIL_FROM` are both set; otherwise `LogMailer`. So dev, the whole test suite, and
  an unconfigured prod all stay on `LogMailer` — no live provider is touched without
  an explicit env flip, and turning real sending on is ONE env change with zero
  call-site change (the webhook keeps calling the `Mailer` port).
- Nothing else moves: the owner-email sourcing (`NotificationsRepository`), the
  template, and the best-effort send loop are reused unchanged.
- **Template is EN-only for v1.** EN/ID/ZH (FR-I18N-1) is a deliberate follow-up, as
  the issue allows ("start EN-only and follow up").

### Why a factory-with-fallback, not the gateway's `useClass` + loud-throw

Payment binds `MidtransGateway` unconditionally and throws a 500 when unconfigured,
because you **cannot fake taking money** — the guest must learn it failed. Email is
the opposite: it is a best-effort post-commit seam, so the sensible unconfigured
behaviour is to degrade **gracefully** to a rendered log line (`LogMailer` already
does this), not to throw a 500 the caller swallows anyway and lose the content. A
confirmed booking must not depend on a mailer being wired. The asymmetry is the
decision, and the factory is what encodes it.

### Alternatives rejected

- **`SmtpMailer` via `nodemailer`.** Provider-agnostic, but adds a dependency and a
  wider config surface (host/port/user/pass/secure). Rejected in favour of the
  `fetch` adapter that matches the codebase's no-SDK, dependency-light grain and adds
  **zero** dependencies. Kept as the documented plan B if an owner wants a generic
  SMTP relay instead of Resend.
- **A real provider bound always, keyed off `NODE_ENV`.** An env-flag stub is a
  second code path that could ship; a factory that binds the actual class only when
  creds exist has no such path, and the test suite proves both branches directly.

## Consequences

- **No suite reaches live Resend.** The test env sets no `RESEND_API_KEY`, so the app
  boots on `LogMailer`; the end-to-end confirmation test additionally
  `.overrideProvider(MAILER)` with a recording fake. The real adapter is proven
  against a mocked `fetch` (`resend-mailer.spec`), the binding against a stub config
  (`mailer.factory.spec`).
- **No migration.** The owner email is already sourced by `NotificationsRepository`
  (the tenant's `owner`-role users), added in #54.
- **New env** (all optional; unset ⇒ `LogMailer`): `RESEND_API_KEY`, `MAIL_FROM`, and
  `RESEND_BASE_URL` (test/override only). Documented in `.env.example`.
- **Deploy step to enable real sending:** verify a sending domain in the Resend
  dashboard (free tier), then set `RESEND_API_KEY` + `MAIL_FROM` in the VPS env. The
  key guards something real, so — like the Midtrans keys — it lives only in the
  gitignored `.env`, never the repo.
- The per-recipient send-loop isolation (#126, a #54 review follow-up: one failing
  send currently short-circuits later recipients) is **out of scope** here and left
  untouched, per the issue's "do not rebuild the send loop".
