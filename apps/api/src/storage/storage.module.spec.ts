import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule } from './storage.module';
import type { StorageService } from './storage.service';

/**
 * The dev bucket bootstrap, decision half (#182). This module is where the lane
 * origin USED to be read (`WEB_ORIGIN` -> `applyDevBucketConfig(origin)`), which
 * is what made the shared bucket's single CORS policy depend on whichever API
 * booted last. Nothing else covered that read, so it is covered here now: when
 * the bootstrap fires, and that it hands the storage layer NOTHING to vary on.
 */
describe('StorageModule.onApplicationBootstrap', () => {
  const applyDevBucketConfig = jest.fn<Promise<void>, []>();

  const bootstrap = (env: Record<string, string>): Promise<void> =>
    new StorageModule(
      { applyDevBucketConfig } as unknown as StorageService,
      new ConfigService(env),
    ).onApplicationBootstrap();

  beforeEach(() => {
    applyDevBucketConfig.mockReset().mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('passes no origin, so a lane cannot make the shared policy its own', async () => {
    // WEB_ORIGIN is set to a lane origin exactly as playwright once did. The
    // assertion is that it reaches the bucket policy in no form whatsoever -
    // re-plumbing it here is what would silently reopen #182.
    await bootstrap({
      STORAGE_BOOTSTRAP: 'true',
      WEB_ORIGIN: 'http://localhost:5174',
    });

    expect(applyDevBucketConfig).toHaveBeenCalledTimes(1);
    expect(applyDevBucketConfig).toHaveBeenCalledWith();
  });

  it('does nothing unless STORAGE_BOOTSTRAP is exactly "true"', async () => {
    // Fail safe, not fail open: this is the flag that keeps a prod process from
    // rewriting a live bucket's CORS, so only the literal string arms it.
    for (const value of ['false', 'TRUE', '1', ' true', '']) {
      await bootstrap({ STORAGE_BOOTSTRAP: value });
    }
    await bootstrap({});

    expect(applyDevBucketConfig).not.toHaveBeenCalled();
  });

  it('warns instead of crashing when Garage is down', async () => {
    // A missing `docker compose up` must not take the API with it - photo
    // uploads simply will not work until it is back.
    applyDevBucketConfig.mockRejectedValue(new Error('ECONNREFUSED'));
    const warn = jest.spyOn(Logger.prototype, 'warn');

    await expect(
      bootstrap({ STORAGE_BOOTSTRAP: 'true' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});
