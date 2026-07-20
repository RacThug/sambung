import { configure } from "@testing-library/react";

// Routes are code-split (#125): the router loads each page's chunk through a
// dynamic `import()`. Under vitest each chunk is transformed on first import, and
// that one cold transform (property-page pulls the date picker) can take longer
// than testing-library's 1s default async timeout before the component resolves -
// so the FIRST render of a lazy route in a file would flake while every later one
// (chunk cached) passes. Give async queries headroom so the split is invisible to
// tests. Production serves pre-built chunks over HTTP in milliseconds; this only
// covers the test transformer's cold start.
configure({ asyncUtilTimeout: 10_000 });
