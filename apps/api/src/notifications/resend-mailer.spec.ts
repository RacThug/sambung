import type { ConfigService } from '@nestjs/config';
import { renderConfirmationEmail } from './confirmation-email';
import { RESEND_DEFAULT_BASE_URL, ResendMailer } from './resend-mailer';

/**
 * The real email adapter (#119, FR-NOTIF-1). No network: `fetch` is mocked, so
 * this proves the adapter shapes the RIGHT Resend request (endpoint, Bearer auth,
 * from/to/subject/body) and that a provider failure REJECTS - which is what makes
 * `NotificationsService`'s best-effort catch log it without failing the webhook
 * (AC (b)). No suite ever reaches live Resend.
 */
describe('ResendMailer', () => {
  const API_KEY = 're_test_key';
  const FROM = 'Sambung <bookings@sambung.test>';
  const originalFetch = global.fetch;

  const configWith = (over: Record<string, string | undefined> = {}) =>
    ({
      get: (key: string) =>
        ({ RESEND_API_KEY: API_KEY, MAIL_FROM: FROM, ...over })[key],
    }) as unknown as ConfigService;

  // A minimal ok Response-like; jest.fn() is untyped so no cast is needed.
  const okResponse = () => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ id: 'msg-1' }),
  });

  // The parsed request body of the Nth fetch call.
  const bodyOfCall = (spy: jest.Mock, n: number): Record<string, unknown> => {
    const calls = spy.mock.calls as unknown[][];
    const init = calls[n][1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  };

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POSTs the message to Resend with Bearer auth and the right payload', async () => {
    const mailer = new ResendMailer(configWith());
    await mailer.send({
      to: 'guest@example.com',
      subject: 'Your booking is confirmed',
      text: 'Hi there,\nYour booking is confirmed.',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown[][];
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_DEFAULT_BASE_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(bodyOfCall(fetchMock, 0)).toMatchObject({
      from: FROM,
      to: 'guest@example.com',
      subject: 'Your booking is confirmed',
      text: 'Hi there,\nYour booking is confirmed.',
    });
  });

  it('sends a distinct request for BOTH the guest and the owner', async () => {
    const mailer = new ResendMailer(configWith());
    // Drive the adapter with the real template so the payload it sends is the one
    // production would - one message to the guest, one to the owner (AC (a)).
    const messages = renderConfirmationEmail({
      bookingId: 'bk-1',
      guestName: 'Made A.',
      guestEmail: 'guest@example.com',
      ownerEmails: ['owner@villa.dev'],
      propertyName: 'Seminyak Villa',
      unitName: 'Garden Room',
      checkIn: '2029-03-10',
      checkOut: '2029-03-14',
      totalPriceIdr: 4_000_000n,
      amountPaidIdr: 1_200_000n,
    });
    for (const message of messages) await mailer.send(message);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOfCall(fetchMock, 0).to).toBe('guest@example.com');
    expect(bodyOfCall(fetchMock, 1).to).toBe('owner@villa.dev');
  });

  it('includes the html part when the message carries one', async () => {
    const mailer = new ResendMailer(configWith());
    await mailer.send({
      to: 'g@example.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
    });
    expect(bodyOfCall(fetchMock, 0).html).toBe('<p>t</p>');
  });

  it('rejects when Resend returns a non-2xx (so the caller can log it)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: () => Promise.resolve('{"message":"invalid from"}'),
    });
    const mailer = new ResendMailer(configWith());
    await expect(
      mailer.send({ to: 'g@example.com', subject: 's', text: 't' }),
    ).rejects.toThrow();
  });

  it('rejects when the network call throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const mailer = new ResendMailer(configWith());
    await expect(
      mailer.send({ to: 'g@example.com', subject: 's', text: 't' }),
    ).rejects.toThrow();
  });

  it('rejects (never silently no-ops) when the API key is missing', async () => {
    const mailer = new ResendMailer(configWith({ RESEND_API_KEY: undefined }));
    await expect(
      mailer.send({ to: 'g@example.com', subject: 's', text: 't' }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
