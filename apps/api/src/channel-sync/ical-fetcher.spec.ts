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

  // Response-like with a null body so readHead falls back to `.text()`.
  const mockFetch = (res: { ok: boolean; status: number; text: string }) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: res.ok,
      status: res.status,
      body: null,
      text: () => Promise.resolve(res.text),
    });
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
});
