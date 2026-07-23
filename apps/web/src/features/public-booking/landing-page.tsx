import { Link } from "@tanstack/react-router";
import { Wordmark } from "@/components/wordmark";
import { useI18n } from "@/i18n/context";
import type { MessageKey } from "@/i18n/messages";

/**
 * The landing page (`/`) - the portfolio front door, replacing the M0 API-health
 * scaffold (#60 follow-up, grill session 2026-07-23).
 *
 * Guests never see this page: they arrive on a property link (`/p/:slug`), never
 * the bare domain (ADR-0004). Its real audience is a portfolio reviewer or a
 * returning owner, so its job is to say what Sambung is, show the engineering
 * depth, and route an owner to sign in - not to be a guest-acquisition funnel.
 *
 * Public-funnel surface, so it is CUSTOM (no shadcn - ADR-0007) and i18n-aware:
 * the language switcher rides above it from `PublicShell`. Fraunces (font-display)
 * carries the headings, the one place a first impression is formed.
 */

// The seed's flagship demo property (packages/db/scripts/seed.ts) - a stable,
// fully-set-up public page. The deployed portfolio runs the seed, so this link
// lands on a real listing; off-seed it 404s like any unknown slug, which is the
// honest failure and not one worth guarding a marketing link against.
const DEMO_SLUG = "seminyak-beach-villa";

// The five boss fights (CLAUDE.md), each its own card. Keys are explicit rather
// than built from an index so `tsc` checks every one against the catalog.
const HARD_PARTS = [
  { n: "01", title: "landing.hard1Title", body: "landing.hard1Body" },
  { n: "02", title: "landing.hard2Title", body: "landing.hard2Body" },
  { n: "03", title: "landing.hard3Title", body: "landing.hard3Body" },
  { n: "04", title: "landing.hard4Title", body: "landing.hard4Body" },
  { n: "05", title: "landing.hard5Title", body: "landing.hard5Body" },
] satisfies ReadonlyArray<{ n: string; title: MessageKey; body: MessageKey }>;

// Tech names are proper nouns, not translatable copy - rendered literally.
const STACK = [
  "React",
  "TypeScript",
  "NestJS",
  "PostgreSQL · RLS",
  "Drizzle",
  "Docker",
];

// Shared CTA styling so the primary/outline button shape can't drift across the
// nav + hero (three near-identical class strings otherwise). Colour and shape
// live here; each call site appends its own size.
const CTA_PRIMARY =
  "rounded-md bg-primary font-medium text-primary-foreground hover:bg-primary/90";
const CTA_OUTLINE =
  "rounded-md border border-input bg-card font-medium hover:bg-accent hover:text-accent-foreground";

export function LandingPage() {
  const { t } = useI18n();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <Wordmark className="text-2xl" />
        <nav className="flex items-center gap-2 text-sm sm:gap-3">
          <Link
            to="/login"
            className="rounded-md px-3 py-2 font-medium text-foreground hover:text-primary"
          >
            {t("landing.navLogin")}
          </Link>
          <Link to="/register" className={`${CTA_PRIMARY} px-4 py-2`}>
            {t("landing.getStarted")}
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        {/* Hero - the thesis. */}
        <section className="py-16 sm:py-24">
          <h1 className="max-w-3xl text-balance font-display text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
            {t("landing.heroTitle")}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            {t("landing.heroBody")}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/p/$slug"
              params={{ slug: DEMO_SLUG }}
              className={`${CTA_PRIMARY} px-5 py-3`}
            >
              {t("landing.viewDemo")} →
            </Link>
            <Link to="/register" className={`${CTA_OUTLINE} px-5 py-3`}>
              {t("landing.getStarted")}
            </Link>
          </div>
        </section>

        {/* The five hard parts - engineering depth for a reviewer. */}
        <section className="border-t border-border py-16">
          <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("landing.hardTitle")}
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            {t("landing.hardBody")}
          </p>
          <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {HARD_PARTS.map((part) => (
              <li
                key={part.n}
                className="rounded-xl border border-border bg-card p-6"
              >
                <span className="text-sm font-semibold tabular-nums text-primary">
                  {part.n}
                </span>
                <h3 className="mt-2 font-semibold text-card-foreground">
                  {t(part.title)}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {t(part.body)}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* Stack. */}
        <section className="border-t border-border py-12">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {t("landing.stackTitle")}
          </h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {STACK.map((item) => (
              <li
                key={item}
                className="rounded-full border border-border bg-card px-3 py-1 text-sm text-muted-foreground"
              >
                {item}
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Wordmark className="text-lg" />
            <span className="text-sm text-muted-foreground">
              {t("landing.footerTagline")}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("landing.forGuests")}
          </p>
        </div>
      </footer>
    </div>
  );
}
