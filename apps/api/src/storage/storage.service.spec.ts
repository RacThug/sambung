import { ConfigService } from '@nestjs/config';
import {
  PutBucketCorsCommand,
  PutBucketWebsiteCommand,
  S3Client,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

/**
 * The dev bucket bootstrap (#182). Pure unit tests - `S3Client.prototype.send`
 * is stubbed, so nothing here talks to Garage and no docker is needed.
 *
 * What is under test is not "a CORS rule is written" but the property that makes
 * writing one SAFE on a shared bucket: every boot writes the SAME policy. Bucket
 * CORS is global to the bucket and one Garage serves every stack pointed at it
 * (`pnpm dev`, `storage:doctor`, each `SAMBUNG_E2E_LANE=<n>` lane on its own web
 * port), so a policy that varied per boot made the last API to start silently
 * 403 every other one's upload preflights.
 */
describe('StorageService.applyDevBucketConfig', () => {
  /** Every command the service put on the wire during a test. */
  const sent: unknown[] = [];

  const serviceWith = (extra: Record<string, string> = {}): StorageService =>
    new StorageService(
      new ConfigService({
        STORAGE_BUCKET: 'sambung-photos',
        STORAGE_PUBLIC_BASE_URL: 'http://photos.test',
        STORAGE_ENDPOINT: 'http://localhost:3900',
        STORAGE_REGION: 'garage',
        STORAGE_ACCESS_KEY_ID: 'key',
        STORAGE_SECRET_ACCESS_KEY: 'secret',
        ...extra,
      }),
    );

  /** The CORS rules of the single PutBucketCors this bootstrap issued. */
  const corsRules = (): CORSRule[] | undefined => {
    const cmd = sent.find(
      (c): c is PutBucketCorsCommand => c instanceof PutBucketCorsCommand,
    );
    expect(cmd).toBeDefined();
    return cmd?.input.CORSConfiguration?.CORSRules;
  };

  beforeEach(() => {
    sent.length = 0;
    // `S3Client.send` is overloaded (one form takes a node-style callback and
    // returns void), so jest infers a signature that is useless to assert
    // against. Narrow it once, here, to "was called with one command" - which
    // is all these tests read.
    const send = jest.spyOn(S3Client.prototype, 'send') as unknown as jest.Mock<
      Promise<unknown>,
      [unknown]
    >;
    send.mockImplementation((command: unknown) => {
      sent.push(command);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('allows a browser PUT from any origin, so no lane can lock another out', async () => {
    await serviceWith().applyDevBucketConfig();

    expect(corsRules()).toEqual([
      {
        AllowedOrigins: ['*'],
        AllowedMethods: ['PUT'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      },
    ]);
  });

  it('writes an identical policy whatever the web origin is - the guard against last-writer-wins', async () => {
    // Two boots that would once have fought over the one bucket: a base
    // `pnpm dev` on :5173 and an e2e lane on :5174. WEB_ORIGIN is set on BOTH,
    // so this proves the policy is genuinely origin-independent rather than
    // merely falling back to a default - which is why a second lane is safe.
    await serviceWith({
      WEB_ORIGIN: 'http://localhost:5173',
    }).applyDevBucketConfig();
    const base = corsRules();

    sent.length = 0;
    await serviceWith({
      WEB_ORIGIN: 'http://localhost:5174',
    }).applyDevBucketConfig();

    expect(corsRules()).toEqual(base);
  });

  it('also applies website access, so Garage serves photos anonymously', async () => {
    await serviceWith().applyDevBucketConfig();

    const website = sent.find(
      (c): c is PutBucketWebsiteCommand => c instanceof PutBucketWebsiteCommand,
    );
    expect(website).toBeDefined();
    expect(website?.input).toEqual({
      Bucket: 'sambung-photos',
      WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } },
    });
  });
});
