import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import cookieParser from 'cookie-parser';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import { tenant, unit } from '@sambung/db';
import {
  PHOTO_GALLERY_CEILING,
  type AuthResponse,
  type PresignPhotoResponse,
  type PropertyResponse,
} from '@sambung/shared';
import { AppModule } from '../app.module';
import { DbService } from '../db/db.service';

// Photo pipeline (FR-PROP-1, api-spec §4.5, #39) over real HTTP + DB + Garage.
// The upload tests PUT real bytes to the storage container - that IS the
// acceptance criterion ("presigned PUT verified working against Garage
// end-to-end", the plan-B trigger check). Requires `docker compose up -d`.
describe('Property photos', () => {
  let app: INestApplication;
  let dbs: DbService;
  const createdTenantIds: string[] = [];
  const uploadedKeys: string[] = [];

  const server = () => app.getHttpServer() as Server;
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

  // Test-side S3 client (same env the API reads) to verify bytes actually
  // landed and to clean up after the suite.
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

  async function registerTenant(name: string) {
    const res = await request(server())
      .post('/api/auth/register')
      .send({
        tenantName: name,
        email: `photos+${randomUUID()}@test.dev`,
        password: 'supersecret1',
      });
    const auth = bodyOf<AuthResponse>(res);
    createdTenantIds.push(auth.tenant.id);
    return auth;
  }

  async function createProperty(token: string, name: string) {
    const res = await request(server())
      .post('/api/properties')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);
    return bodyOf<PropertyResponse>(res);
  }

  function presign(
    token: string,
    propertyId: string,
    body: Record<string, unknown> = { contentType: 'image/jpeg', size: 4 },
  ) {
    return request(server())
      .post(`/api/properties/${propertyId}/photos/presign`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  // A real JFIF header: PATCH verifies magic bytes, so fixtures must open
  // like an actual jpeg (declared type alone no longer earns a gallery slot).
  const JPEG_BYTES = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01,
  ]);

  /** Presign + PUT real bytes to Garage; returns the persisted-ready key. */
  async function uploadPhoto(
    token: string,
    propertyId: string,
    bytes = JPEG_BYTES,
  ): Promise<string> {
    const res = await presign(token, propertyId, {
      contentType: 'image/jpeg',
      size: bytes.length,
    }).expect(201);
    const { uploadUrl, key } = bodyOf<PresignPhotoResponse>(res);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.ok).toBe(true);
    uploadedKeys.push(key);
    return key;
  }

  function patchPhotos(token: string, propertyId: string, keys: string[]) {
    return request(server())
      .patch(`/api/properties/${propertyId}/photos`)
      .set('Authorization', `Bearer ${token}`)
      .send({ keys });
  }

  let tokenA: string;
  let tenantAId: string;
  let tokenB: string;
  let tenantBId: string;
  let propA: PropertyResponse;
  let propA2: PropertyResponse;
  let propB: PropertyResponse;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    dbs = app.get(DbService);

    const a = await registerTenant('Photos Tenant A');
    const b = await registerTenant('Photos Tenant B');
    tokenA = a.accessToken;
    tenantAId = a.tenant.id;
    tokenB = b.accessToken;
    tenantBId = b.tenant.id;
    propA = await createProperty(tokenA, 'Photo Villa A');
    propA2 = await createProperty(tokenA, 'Photo Villa A2');
    propB = await createProperty(tokenB, 'Photo Villa B');
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

  describe('POST /api/properties/:id/photos/presign', () => {
    it('returns a tenant-prefixed key and a presigned URL (201)', async () => {
      const res = await presign(tokenA, propA.id).expect(201);
      const body = bodyOf<PresignPhotoResponse>(res);
      expect(body.key).toMatch(
        new RegExp(`^${tenantAId}/${propA.id}/[0-9a-f-]{36}\\.jpg$`),
      );
      expect(body.expiresInSeconds).toBeGreaterThan(0);
      const url = new URL(body.uploadUrl);
      // Path-style: <endpoint>/<bucket>/<key>, signed with SigV4.
      expect(body.uploadUrl.startsWith(process.env.STORAGE_ENDPOINT!)).toBe(
        true,
      );
      expect(url.pathname).toBe(`/${bucket}/${body.key}`);
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
      // The content type is part of the signature - a lying client's PUT
      // fails at the storage layer, not just at our validation.
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
        'content-type',
      );
    });

    it('maps extensions per content type', async () => {
      const res = await presign(tokenA, propA.id, {
        contentType: 'image/webp',
        size: 10,
      }).expect(201);
      expect(bodyOf<PresignPhotoResponse>(res).key).toMatch(/\.webp$/);
    });

    it('rejects a content type outside the whitelist (400)', async () => {
      await presign(tokenA, propA.id, {
        contentType: 'image/gif',
        size: 10,
      }).expect(400);
      await presign(tokenA, propA.id, {
        contentType: 'application/pdf',
        size: 10,
      }).expect(400);
    });

    it('rejects an oversized file (400)', async () => {
      await presign(tokenA, propA.id, {
        contentType: 'image/jpeg',
        size: 5 * 1024 * 1024 + 1,
      }).expect(400);
    });

    it("404s another tenant's property - indistinguishable from unknown", async () => {
      await presign(tokenA, propB.id).expect(404);
      await presign(tokenA, randomUUID()).expect(404);
    });

    it('401s without a token, 400s a malformed id', async () => {
      await request(server())
        .post(`/api/properties/${propA.id}/photos/presign`)
        .send({ contentType: 'image/jpeg', size: 4 })
        .expect(401);
      await presign(tokenA, 'not-a-uuid').expect(400);
    });

    it('does not persist anything by itself', async () => {
      const res = await request(server())
        .get(`/api/properties/${propA.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<PropertyResponse>(res).photos).toEqual([]);
    });
  });

  describe('presigned PUT against real Garage (plan-B trigger check)', () => {
    it('uploads bytes end-to-end and they are readable back', async () => {
      const bytes = JPEG_BYTES;
      const key = await uploadPhoto(tokenA, propA.id, bytes);
      const got = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      expect(Buffer.from(await got.Body!.transformToByteArray())).toEqual(
        bytes,
      );
      expect(got.ContentType).toBe('image/jpeg');
    });

    it('rejects a PUT whose Content-Type differs from the presigned one', async () => {
      const res = await presign(tokenA, propA.id, {
        contentType: 'image/jpeg',
        size: 4,
      }).expect(201);
      const { uploadUrl, key } = bodyOf<PresignPhotoResponse>(res);
      uploadedKeys.push(key); // in case the backend accepts it after all
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: Buffer.from('test'),
      });
      expect(put.ok).toBe(false);
      expect(put.status).toBe(403); // signature mismatch
    });

    it('rejects a PUT whose size differs from the presigned one', async () => {
      // content-length is a signed header: declaring 4 bytes then sending
      // more must fail - the 5 MB cap can't be dodged after presigning.
      const res = await presign(tokenA, propA.id, {
        contentType: 'image/jpeg',
        size: 4,
      }).expect(201);
      const { uploadUrl, key } = bodyOf<PresignPhotoResponse>(res);
      uploadedKeys.push(key); // in case the backend accepts it after all
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from('way-more-than-four-bytes'),
      });
      expect(put.ok).toBe(false);
      expect(put.status).toBe(403); // signature mismatch
    });
  });

  describe('PATCH /api/properties/:id/photos', () => {
    it('persists keys in order and returns them as public URLs (200)', async () => {
      const k1 = await uploadPhoto(tokenA, propA.id);
      const k2 = await uploadPhoto(tokenA, propA.id);
      const res = await patchPhotos(tokenA, propA.id, [k1, k2]).expect(200);
      const body = bodyOf<PropertyResponse>(res);
      expect(body.photos).toEqual([
        { key: k1, url: `${process.env.STORAGE_PUBLIC_BASE_URL}/${k1}` },
        { key: k2, url: `${process.env.STORAGE_PUBLIC_BASE_URL}/${k2}` },
      ]);

      // Round-trips through GET, same order.
      const get = await request(server())
        .get(`/api/properties/${propA.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(bodyOf<PropertyResponse>(get).photos.map((p) => p.key)).toEqual([
        k1,
        k2,
      ]);
    });

    it('is a whole-set operation: reorder, delete, and idempotent replays', async () => {
      const current = await request(server())
        .get(`/api/properties/${propA.id}`)
        .set('Authorization', `Bearer ${tokenA}`);
      const [k1, k2] = bodyOf<PropertyResponse>(current).photos.map(
        (p) => p.key,
      );

      const reordered = await patchPhotos(tokenA, propA.id, [k2, k1]).expect(
        200,
      );
      expect(
        bodyOf<PropertyResponse>(reordered).photos.map((p) => p.key),
      ).toEqual([k2, k1]);

      // Same request again - same result (idempotent).
      const replay = await patchPhotos(tokenA, propA.id, [k2, k1]).expect(200);
      expect(bodyOf<PropertyResponse>(replay).photos.map((p) => p.key)).toEqual(
        [k2, k1],
      );

      // Dropping a key from the set deletes it from the gallery.
      const dropped = await patchPhotos(tokenA, propA.id, [k2]).expect(200);
      expect(
        bodyOf<PropertyResponse>(dropped).photos.map((p) => p.key),
      ).toEqual([k2]);
    });

    it('flips publishable: photo + priced unit = true, no photos = false', async () => {
      await dbs.db.insert(unit).values({
        tenantId: tenantAId,
        propertyId: propA.id,
        name: 'Room',
        basePriceIdr: 500000n,
      });
      const key = await uploadPhoto(tokenA, propA.id);

      const withPhoto = await patchPhotos(tokenA, propA.id, [key]).expect(200);
      expect(bodyOf<PropertyResponse>(withPhoto).publishable).toBe(true);

      const cleared = await patchPhotos(tokenA, propA.id, []).expect(200);
      expect(bodyOf<PropertyResponse>(cleared).publishable).toBe(false);
    });

    it("rejects keys that don't carry this property's prefix (400)", async () => {
      // Another tenant's prefix.
      await patchPhotos(tokenA, propA.id, [
        `${tenantBId}/${propB.id}/${randomUUID()}.jpg`,
      ]).expect(400);
      // Same tenant, different property - photos don't move between galleries.
      await patchPhotos(tokenA, propA.id, [
        `${tenantAId}/${propA2.id}/${randomUUID()}.jpg`,
      ]).expect(400);
    });

    it('rejects malformed bodies (400): duplicates, bad charset, oversize list', async () => {
      const key = `${tenantAId}/${propA.id}/${randomUUID()}.jpg`;
      await patchPhotos(tokenA, propA.id, [key, key]).expect(400);
      await patchPhotos(tokenA, propA.id, [
        `${tenantAId}/${propA.id}/evil key?.jpg`,
      ]).expect(400);
      await patchPhotos(
        tokenA,
        propA.id,
        Array.from(
          { length: PHOTO_GALLERY_CEILING + 1 },
          () => `${tenantAId}/${propA.id}/${randomUUID()}.jpg`,
        ),
      ).expect(400);
    });

    it("404s another tenant's property even with a valid-shaped body", async () => {
      await patchPhotos(tokenA, propB.id, []).expect(404);
    });

    it('rejects a key that was presigned but never uploaded (400)', async () => {
      const res = await presign(tokenA, propA.id).expect(201);
      const { key } = bodyOf<PresignPhotoResponse>(res);
      const patch = await patchPhotos(tokenA, propA.id, [key]).expect(400);
      expect(JSON.stringify(patch.body)).toContain('Not an uploaded image');
    });

    it('rejects an upload whose bytes are not the image they claim (400)', async () => {
      // Correct declared type, correct size, real upload - but the content
      // is not a jpeg. Magic-byte verification at PATCH is the last gate.
      const junk = Buffer.from('<html>not-an-image</html>');
      const res = await presign(tokenA, propA.id, {
        contentType: 'image/jpeg',
        size: junk.length,
      }).expect(201);
      const { uploadUrl, key } = bodyOf<PresignPhotoResponse>(res);
      uploadedKeys.push(key);
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: junk,
      });
      expect(put.ok).toBe(true); // storage accepts it - the PATCH must not
      await patchPhotos(tokenA, propA.id, [key]).expect(400);
    });
  });

  // The tenant-configurable cap (#67, ADR-0030). Its own tenant, so lowering the
  // cap here cannot reach the galleries the tests above are building.
  describe('the gallery cap', () => {
    let tokenC: string;
    let propC: PropertyResponse;
    let k1: string;
    let k2: string;
    let k3: string;

    const setCap = (galleryCap: number) =>
      request(server())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${tokenC}`)
        .send({ galleryCap })
        .expect(200);

    const photoCount = async (): Promise<number> => {
      const res = await request(server())
        .get(`/api/properties/${propC.id}`)
        .set('Authorization', `Bearer ${tokenC}`)
        .expect(200);
      return bodyOf<PropertyResponse>(res).photos.length;
    };

    beforeAll(async () => {
      const c = await registerTenant('Photos Tenant C');
      tokenC = c.accessToken;
      propC = await createProperty(tokenC, 'Photo Villa C');
      k1 = await uploadPhoto(tokenC, propC.id);
      k2 = await uploadPhoto(tokenC, propC.id);
      k3 = await uploadPhoto(tokenC, propC.id);
    });

    /**
     * Put the tenant at `galleryCap` with exactly `keys` in the gallery, from
     * whatever the previous test left behind. Order matters: raise the cap
     * first so seeding a gallery is never itself refused by the cap under test.
     *
     * Each test seeds its own world rather than inheriting the last one's - a
     * chain of `it`s that only passes in file order is a chain that breaks on a
     * `.only` or a reorder, and does it silently.
     */
    async function given(galleryCap: number, keys: string[]) {
      await setCap(PHOTO_GALLERY_CEILING);
      await patchPhotos(tokenC, propC.id, keys).expect(200);
      await setCap(galleryCap);
    }

    it('accepts a gallery up to the cap and refuses the one that grows past it', async () => {
      await given(2, [k1, k2]);

      const over = await patchPhotos(tokenC, propC.id, [k1, k2, k3]).expect(
        400,
      );
      expect(JSON.stringify(over.body)).toContain('Gallery is full');
      expect(await photoCount()).toBe(2);
    });

    it('lowering the cap below a live gallery deletes nothing', async () => {
      await given(1, [k1, k2]);
      expect(await photoCount()).toBe(2);
    });

    it('an over-cap gallery can still be reordered and shrunk', async () => {
      // Cap 1, gallery 2. Both of these send MORE keys than the cap and both
      // must pass: neither grows the gallery. A plain `length > cap` check would
      // trap the owner here with no way back down.
      await given(1, [k1, k2]);

      const reordered = await patchPhotos(tokenC, propC.id, [k2, k1]).expect(
        200,
      );
      expect(
        bodyOf<PropertyResponse>(reordered).photos.map((p) => p.key),
      ).toEqual([k2, k1]);

      await patchPhotos(tokenC, propC.id, [k2]).expect(200);
      expect(await photoCount()).toBe(1);
    });

    it('accepts a same-length swap over the cap - closed to growth, not frozen', async () => {
      // Cap 1, gallery 2, and this drops k1 for k3: a photo NEW to the gallery
      // lands while the gallery is over its cap. Deliberate (ADR-0030) - the
      // bound is on count, so an owner can still replace a bad cover photo; the
      // one thing they cannot do is reach 3. Pinned so it stays a decision.
      await given(1, [k1, k2]);

      const swapped = await patchPhotos(tokenC, propC.id, [k3, k2]).expect(200);
      expect(
        bodyOf<PropertyResponse>(swapped).photos.map((p) => p.key),
      ).toEqual([k3, k2]);
      expect(await photoCount()).toBe(2);

      await patchPhotos(tokenC, propC.id, [k3, k2, k1]).expect(400);
    });

    it('refuses to grow back over the lowered cap, then allows it once raised', async () => {
      // Gallery 1, cap 1: adding the second is a genuine new add.
      await given(1, [k2]);
      await patchPhotos(tokenC, propC.id, [k2, k1]).expect(400);
      expect(await photoCount()).toBe(1);

      await setCap(2);
      await patchPhotos(tokenC, propC.id, [k2, k1]).expect(200);
      expect(await photoCount()).toBe(2);
    });

    it("one tenant's cap does not bind another's gallery", async () => {
      // Tenant C is capped at 2; tenant A is on the default and unaffected.
      const keys = [
        await uploadPhoto(tokenA, propA2.id),
        await uploadPhoto(tokenA, propA2.id),
        await uploadPhoto(tokenA, propA2.id),
      ];
      await patchPhotos(tokenA, propA2.id, keys).expect(200);
    });
  });
});
