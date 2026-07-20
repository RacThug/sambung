import type {
  IcalFetcher,
  IcalFetchResult,
  IcalProbeResult,
} from './ical-fetcher';

/**
 * The test / offline binding for the iCal boundary (api-spec §8.5). Bound in
 * place of HttpIcalFetcher via `.overrideProvider(ICAL_FETCHER)`, so both connect
 * (probe) AND the import pipeline (fetchFeed) run end-to-end with no network - the
 * same pattern as FakePaymentGateway (ADR-0015).
 *
 * Deterministic and inspectable: it records every URL it was asked to reach (so a
 * test can assert the fetch happened, and how many times). `probe` returns
 * `nextResult` (defaults healthy). `fetchFeed` returns whatever body a test staged
 * for that URL via `setFeed(url, body)`; an unstaged URL is an unreachable feed,
 * which is exactly how a test drives the `last_status = 'error'` branch.
 */
export class FakeIcalFetcher implements IcalFetcher {
  readonly calls: string[] = [];
  nextResult: IcalProbeResult = { ok: true, error: null };
  private readonly feeds = new Map<string, IcalFetchResult>();

  probe(url: string): Promise<IcalProbeResult> {
    this.calls.push(url);
    return Promise.resolve(this.nextResult);
  }

  fetchFeed(url: string): Promise<IcalFetchResult> {
    this.calls.push(url);
    const staged = this.feeds.get(url);
    if (staged) return Promise.resolve(staged);
    return Promise.resolve({
      ok: false,
      body: null,
      error: 'Feed is unreachable',
    });
  }

  /** Stage a healthy feed body for a URL (the import pipeline will pull it). */
  setFeed(url: string, body: string): void {
    this.feeds.set(url, { ok: true, body, error: null });
  }

  /** Stage a transport-level failure for a URL (drives the error-status branch). */
  setFeedError(url: string, error: string): void {
    this.feeds.set(url, { ok: false, body: null, error });
  }

  /** Forget all staged feeds and recorded calls - call between tests. */
  reset(): void {
    this.calls.length = 0;
    this.nextResult = { ok: true, error: null };
    this.feeds.clear();
  }
}
