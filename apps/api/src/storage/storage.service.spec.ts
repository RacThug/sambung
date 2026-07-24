import { ConfigService } from '@nestjs/config';
import {
  PutBucketCorsCommand,
  PutBucketWebsiteCommand,
  S3Client,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

/**
 * The dev bucket bootstrap, storage half (#182). Pure unit tests -
 * `S3Client.prototype.send` is stubbed, so nothing here talks to Garage and no
 * docker is needed.
 *
 * What is under test is the policy this service PUTS. Bucket CORS is global to
 * the bucket and one Garage serves every stack pointed at it (`pnpm dev`,
 * `storage:doctor`, each `SAMBUNG_E2E_LANE=<n>` lane on its own web port), so a
 * policy that varied per boot made the last API to start silently 403 every
 * other one's upload preflights. The other half of that property - that no
 * caller can feed an origin back in - is pinned in storage.module.spec.ts, which
 * is where the origin used to be read.
 */
describe('StorageService.applyDevBucketConfig', () => {
  /** Every command the service put on the wire during a test. */
  const sent: unknown[] = [];

  const service = (): StorageService =>
    new StorageService(
      new ConfigService({
        STORAGE_BUCKET: 'sambung-photos',
        STORAGE_PUBLIC_BASE_URL: 'http://photos.test',
        STORAGE_ENDPOINT: 'http://localhost:3900',
        STORAGE_REGION: 'garage',
        STORAGE_ACCESS_KEY_ID: 'key',
        STORAGE_SECRET_ACCESS_KEY: 'secret',
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
    await service().applyDevBucketConfig();

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

  it('widens nothing but PUT - reads are the website endpoint, not this rule', async () => {
    // The one thing `*` must not become is a bucket that answers any method
    // from any page. Garage was measured refusing GET/POST/DELETE from a
    // hostile origin under this exact policy; this pins the input that makes
    // that true, so a later "just add GET" cannot pass unnoticed.
    await service().applyDevBucketConfig();

    expect(corsRules()?.[0]?.AllowedMethods).toEqual(['PUT']);
  });

  it('also applies website access, so Garage serves photos anonymously', async () => {
    await service().applyDevBucketConfig();

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
