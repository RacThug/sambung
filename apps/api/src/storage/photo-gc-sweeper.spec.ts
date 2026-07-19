import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { property, tenant } from '@sambung/db';
import {
  MAX_PHOTO_SIZE_BYTES,
  type AuthResponse,
  type PropertyResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';
import { PhotoGcSweeperService } from './photo-gc-sweeper.service';
import { PHOTO_GC_GRACE_MS } from './storage.constants';

// Orphaned-photo GC sweep (#69, ADR-0016) over real DB + Garage. It DELETES
// storage objects, and the Garage bucket is SHARED across worktree lanes while
// each lane's DB is isolated - so every object here is test-owned (a key under a
// freshly-registered tenant's prefix), every sweep is confined to that tenant
// (`sweep(now, [tenantId])`) so it can never touch another suite's in-flight
// objects, and cleanup deletes exactly what it created. Requires
// `docker compose up -d`.
describe('Photo GC sweeper', () => {
  let app: INestApplication;
  let dbs: DbService;
  let sweeper: PhotoGcSweeperService;

  const createdTenantIds: string[] = [];
  const uploadedKeys: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  // Test-side S3 client (same env the API reads) to seed objects of arbitrary
  // size/age directly and to verify the sweep's decision + clean up.
  const s3 = new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT!,
    region: process.env.STORAGE_REGION!,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bucket = process.env.STORAGE_BUCKET!;

  let tenantId: string;
  let emptyTenantId: string;
  let propId: string;

  async function registerTenant(name: string): Promise<AuthResponse> {
    const res = await request(server()).post('/api/auth/register').send({
      tenantName: name,
      email: `gc+${randomUUID()}@test.dev`,
      password: 'supersecret1',
    });
    const auth = bodyOf<AuthResponse>(res);
    createdTenantIds.push(auth.tenant.id);
    return auth;
  }

  /** A well-formed, test-owned key under the property's prefix. */
  const keyFor = () => `${tenantId}/${propId}/${randomUUID()}.jpg`;

  /** Seed a real object of a given size. Tracked for cleanup. */
  async function putObject(key: string, body: Buffer): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'image/jpeg',
      }),
    );
    uploadedKeys.push(key);
  }

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /** Seed the gallery directly on the owner connection (bypasses PATCH). */
  async function setGallery(keys: string[]): Promise<void> {
    await dbs.db
      .update(property)
      .set({ photos: keys })
      .where(eq(property.id, propId));
  }

  async function getGallery(): Promise<string[]> {
    const [row] = await dbs.db
      .select({ photos: property.photos })
      .from(property)
      .where(eq(property.id, propId));
    return row.photos;
  }

  const SMALL = Buffer.from('a-small-object');
  // Just over the 5 MB cap - the oversize backstop's trigger.
  const OVERSIZE = Buffer.alloc(MAX_PHOTO_SIZE_BYTES + 1024, 0x61);
  // 25 h in the future: relative to it, an object uploaded "now" is past the
  // 24 h grace window, without faking its server-set mtime (ADR-0016 §3).
  const aged = () => new Date(Date.now() + PHOTO_GC_GRACE_MS + 60 * 60 * 1000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);
    sweeper = app.get(PhotoGcSweeperService);

    const a = await registerTenant('GC Tenant A');
    tenantId = a.tenant.id;
    const empty = await registerTenant('GC Tenant Empty');
    emptyTenantId = empty.tenant.id;

    const res = await request(server())
      .post('/api/properties')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ name: 'GC Villa' })
      .expect(201);
    propId = bodyOf<PropertyResponse>(res).id;
  });

  afterAll(async () => {
    if (uploadedKeys.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: uploadedKeys.map((Key) => ({ Key })) },
        }),
      );
    }
    if (createdTenantIds.length) {
      await dbs.db.delete(tenant).where(inArray(tenant.id, createdTenantIds));
    }
    await app.close();
    s3.destroy();
  });

  it('deletes an unreferenced object past the grace window, never a referenced one', async () => {
    const refKey = keyFor();
    const orphanKey = keyFor();
    await putObject(refKey, SMALL);
    await putObject(orphanKey, SMALL);
    await setGallery([refKey]); // only refKey is referenced

    const result = await sweeper.sweep(aged(), [tenantId]);

    // THE invariant: a referenced key survives even when it is "old".
    expect(await objectExists(refKey)).toBe(true);
    // An unreferenced key past the window is reclaimed.
    expect(await objectExists(orphanKey)).toBe(false);
    // The gallery is untouched by an orphan sweep.
    expect(await getGallery()).toEqual([refKey]);
    expect(result.deletedOrphans).toBeGreaterThanOrEqual(1);
    expect(result.evictedOversize).toBe(0);
  });

  it('is idempotent: a second sweep reclaims nothing more', async () => {
    // The gallery from the previous test still references refKey; the orphan is
    // already gone. A second aged sweep confined to this tenant finds no
    // unreferenced-old object left.
    const result = await sweeper.sweep(aged(), [tenantId]);
    expect(result.deletedOrphans).toBe(0);
    expect(result.evictedOversize).toBe(0);
    expect((await getGallery()).length).toBe(1); // still referenced, still there
  });

  it('spares an unreferenced object still inside the grace window (in-flight upload)', async () => {
    const freshKey = keyFor();
    await putObject(freshKey, SMALL); // uploaded "now", not referenced

    // Real clock: the object's mtime is inside the 24 h window, so even though
    // it is unreferenced it must NOT be reclaimed - it could be a PUT whose
    // PATCH has not landed yet.
    const result = await sweeper.sweep(new Date(), [tenantId]);

    expect(await objectExists(freshKey)).toBe(true);
    expect(result.deletedOrphans).toBe(0);
  });

  it('evicts an oversize object, strips it from the gallery, logs loudly, spares the rest', async () => {
    const smallKey = keyFor();
    const bigKey = keyFor();
    await putObject(smallKey, SMALL);
    await putObject(bigKey, OVERSIZE);
    await setGallery([smallKey, bigKey]); // both referenced

    const warn = jest.spyOn(Logger.prototype, 'warn');
    // Real clock: oversize eviction ignores the grace window (a legitimate
    // upload can never exceed the signed size cap), so a just-uploaded oversize
    // object is evicted immediately.
    const result = await sweeper.sweep(new Date(), [tenantId]);

    expect(await objectExists(bigKey)).toBe(false); // evicted
    expect(await objectExists(smallKey)).toBe(true); // within cap + referenced
    // The oversize key is stripped from the gallery it was wrongly in.
    expect(await getGallery()).toEqual([smallKey]);
    expect(result.evictedOversize).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(bigKey));
    warn.mockRestore();
  });

  it('is safe on a tenant whose prefix holds no objects (empty bucket path)', async () => {
    const result = await sweeper.sweep(new Date(), [emptyTenantId]);
    expect(result).toEqual({ deletedOrphans: 0, evictedOversize: 0 });
  });
});
