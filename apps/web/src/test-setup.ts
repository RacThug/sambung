import { configure } from "@testing-library/react";

// Routes are code-split (#125): the router loads each page's chunk through a
// dynamic `import()`. Under vitest each chunk is transformed on first import, and
// that one cold transform (property-page pulls the date picker) can take longer
// than testing-library's 1s default async timeout before the component resolves -
// so the FIRST render of a lazy route in a file would flake while every later one
// (chunk cached) passes. Give async queries headroom so the split is invisible to
// tests. Production serves pre-built chunks over HTTP in milliseconds; this only
// covers the test transformer's cold start.
//
// That headroom is real time, not slack: the transform is CPU-bound, so it grows
// with whatever else is running. Which is why the root `test` script runs turbo
// with `--concurrency=1` - letting jest (api) and vitest (web) oversubscribe the
// same cores pushed exactly these first renders past this budget, and a suite
// whose result depends on core count is not a suite. Serialising costs ~5s of
// wall time and buys a deterministic answer.
configure({ asyncUtilTimeout: 10_000 });
