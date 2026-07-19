import { HttpIcalFetcher } from './ical-fetcher';

/**
 * The REAL outbound adapter. The E2E suite binds a fake, so the adapter's own
 * logic - https-only, private-host block, HTTP status handling, iCal sniffing -
 * needs direct coverage here. `fetch` is mocked so nothing leaves the process.
 */
describe('HttpIcalFetcher', () => {
  const fetcher = new HttpIcalFetcher();
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // A minimal Response-like: null body so readHead falls back to `.text()`, and a
  // `headers.get` so the redirect path can read Location.
  interface MockRes {
    ok?: boolean;
    status: number;
    text?: string;
    location?: string;
  }
  const asResponse = (r: MockRes) => ({
    ok: r.ok ?? (r.status >= 200 && r.status < 300),
    status: r.status,
    body: null,
    text: () => Promise.resolve(r.text ?? ''),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'location' ? (r.location ?? null) : null,
    },
  });

  // Single response for every call.
  const mockFetch = (res: MockRes) => {
    global.fetch = jest.fn().mockResolvedValue(asResponse(res));
  };

  // A sequence of responses, one per call (for redirect chains). Returns the spy.
  const mockFetchSequence = (responses: MockRes[]) => {
    const spy = jest.fn();
    responses.forEach((r) => spy.mockResolvedValueOnce(asResponse(r)));
    global.fetch = spy;
    return spy;
  };

  it('reports ok for a 2xx iCalendar feed', async () => {
    mockFetch({
      ok: true,
      status: 200,
      text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    });
    expect(await fetcher.probe('https://airbnb.com/ical/x.ics')).toEqual({
      ok: true,
      error: null,
    });
  });

  it('reports error when the body is not an iCalendar feed', async () => {
    mockFetch({ ok: true, status: 200, text: '<html>not a calendar</html>' });
    const r = await fetcher.probe('https://airbnb.com/oops');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not an iCalendar/i);
  });

  it('reports error on a non-2xx response', async () => {
    mockFetch({ ok: false, status: 404, text: '' });
    const r = await fetcher.probe('https://airbnb.com/gone.ics');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('404');
  });

  it('reports error and never fetches an http URL', async () => {
    const spy = jest.fn();
    global.fetch = spy;
    const r = await fetcher.probe('http://airbnb.com/x.ics');
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks private / loopback hosts before fetching (SSRF hygiene)', async () => {
    const spy = jest.fn();
    global.fetch = spy;
    for (const url of [
      'https://localhost/x.ics',
      'https://127.0.0.1/x.ics',
      'https://169.254.169.254/latest/meta-data', // cloud metadata
      'https://10.0.0.5/x.ics',
      'https://192.168.1.1/x.ics',
      'https://172.16.0.9/x.ics',
    ]) {
      const r = await fetcher.probe(url);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not allowed/i);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports error when the feed is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await fetcher.probe('https://airbnb.com/x.ics');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unreachable/i);
  });

  // THE SSRF fix: a public host that 302s to a private one must be REFUSED, and
  // the private target must never be fetched. `redirect: 'follow'` would have
  // silently followed it - the block has to hold across hops, not just at the door.
  it('refuses a redirect to a blocked (metadata) host and never fetches it', async () => {
    const spy = mockFetchSequence([
      { status: 302, location: 'https://169.254.169.254/latest/meta-data' },
    ]);
    const r = await fetcher.probe('https://feeds.airbnb.com/redir');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not allowed/i);
    // Only the initial (public) host was hit; the redirect target never was.
    expect(spy).toHaveBeenCalledTimes(1);
    const calls = spy.mock.calls as unknown[][];
    expect(String(calls[0][0])).toContain('feeds.airbnb.com');
  });

  it('refuses a redirect that downgrades to http', async () => {
    mockFetchSequence([{ status: 301, location: 'http://airbnb.com/x.ics' }]);
    const r = await fetcher.probe('https://airbnb.com/redir');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https/i);
  });

  // A normal redirect (https CDN hop) to a real feed still works.
  it('follows a redirect to a valid https iCal host', async () => {
    mockFetchSequence([
      { status: 302, location: 'https://cdn.airbnb.com/ical/x.ics' },
      { status: 200, text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' },
    ]);
    expect(await fetcher.probe('https://airbnb.com/ical/x.ics')).toEqual({
      ok: true,
      error: null,
    });
  });

  it('gives up after too many redirects', async () => {
    // Every call 302s to another public host - never terminates on its own.
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        asResponse({ status: 302, location: 'https://a.example/next' }),
      );
    const r = await fetcher.probe('https://airbnb.com/loop');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too many redirects/i);
  });
});
