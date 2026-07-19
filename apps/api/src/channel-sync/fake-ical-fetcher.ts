import type { IcalFetcher, IcalProbeResult } from './ical-fetcher';

/**
 * The test / offline binding for the iCal boundary (api-spec §8.5). Bound in
 * place of HttpIcalFetcher via `.overrideProvider(ICAL_FETCHER)`, so the connect
 * endpoint runs end-to-end with no network - the same pattern as
 * FakePaymentGateway (ADR-0015).
 *
 * Deterministic and inspectable: it records every URL it was asked to probe (so a
 * test can assert the smoke fetch happened, and how many times), and returns a
 * result the test sets. Defaults to healthy; set `nextResult` to drive the
 * error-status branch.
 */
export class FakeIcalFetcher implements IcalFetcher {
  readonly calls: string[] = [];
  nextResult: IcalProbeResult = { ok: true, error: null };

  probe(url: string): Promise<IcalProbeResult> {
    this.calls.push(url);
    return Promise.resolve(this.nextResult);
  }
}
