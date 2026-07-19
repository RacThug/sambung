import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  PHOTO_EXTENSIONS,
  type PhotoContentType,
  type PresignPhotoResponse,
} from '@sambung/shared';

/** Short-lived: the browser uploads immediately after asking. */
const PRESIGN_EXPIRES_SECONDS = 300;

/** S3 DeleteObjects caps at 1000 keys per request; the GC sweep chunks to it. */
const DELETE_BATCH_MAX = 1000;

/** One stored object as the GC sweep needs to reason about it (ADR-0016). */
export interface StorageObject {
  key: string;
  /** Bytes. Drives the oversize-eviction backstop. */
  size: number;
  /** Server-set on PUT. Drives the grace window (never-race-an-upload). */
  lastModified: Date | undefined;
}

/**
 * Magic-byte checks per whitelisted type, against the object's first 12
 * bytes. The presigned upload already pins the DECLARED content type
 * cryptographically; this verifies the CONTENT is really that image format.
 */
const MAGIC_BYTES: Record<PhotoContentType, (head: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) =>
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP',
};

// S3-compatible object storage (architecture §3.6, #39). One client, one
// contract - Garage (dev) or Cloudflare R2 (prod) purely by env config. The
// API only ever signs URLs and composes public ones; photo bytes never pass
// through it.
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('STORAGE_BUCKET');
    this.publicBaseUrl = config
      .getOrThrow<string>('STORAGE_PUBLIC_BASE_URL')
      .replace(/\/+$/, '');
    this.client = new S3Client({
      endpoint: config.getOrThrow<string>('STORAGE_ENDPOINT'),
      region: config.getOrThrow<string>('STORAGE_REGION'),
      credentials: {
        accessKeyId: config.getOrThrow<string>('STORAGE_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('STORAGE_SECRET_ACCESS_KEY'),
      },
      // Bucket-in-path (`/bucket/key`) works on any endpoint without
      // wildcard-DNS vhosts - both Garage and R2 support it.
      forcePathStyle: true,
      // SDK >= 3.729 adds CRC32 checksum headers by default; non-AWS backends
      // (Garage, R2) reject them on presigned PUTs. Only checksum when the
      // operation requires it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Every photo key of a property starts with this - the ownership stamp. */
  photoKeyPrefix(tenantId: string, propertyId: string): string {
    return `${tenantId}/${propertyId}/`;
  }

  /**
   * Presign a photo upload. Content type and length are SIGNED headers: the
   * upload must repeat exactly what was validated here or storage rejects it
   * with a signature mismatch - the whitelist can't be bypassed after the
   * fact by a lying client.
   */
  async presignPhotoUpload(opts: {
    tenantId: string;
    propertyId: string;
    contentType: PhotoContentType;
    size: number;
  }): Promise<PresignPhotoResponse> {
    const key =
      this.photoKeyPrefix(opts.tenantId, opts.propertyId) +
      `${randomUUID()}.${PHOTO_EXTENSIONS[opts.contentType]}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: opts.contentType,
        ContentLength: opts.size,
      }),
      {
        expiresIn: PRESIGN_EXPIRES_SECONDS,
        // The presigner signs content-length but silently DROPS content-type
        // from the signature unless forced (verified against the URL it
        // emits). Without this, a client could presign a jpeg and upload
        // an html file - the whitelist must hold at the storage layer.
        signableHeaders: new Set(['content-type']),
      },
    );
    return { uploadUrl, key, expiresInSeconds: PRESIGN_EXPIRES_SECONDS };
  }

  /** Public (anonymous-GET) URL the browser renders a stored photo from. */
  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  /**
   * True iff the object exists AND its first bytes are the image format its
   * stored content type claims. "Trust no external input" applied to the
   * storage side: a gallery may only reference keys that hold real images -
   * a presigned-but-never-uploaded key or junk-bytes-as-jpeg both fail.
   * One ranged GET (12 bytes), paid only for keys newly added to a gallery.
   */
  async isValidPhotoObject(key: string): Promise<boolean> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: 'bytes=0-11',
        }),
      );
      const head = Buffer.from(await res.Body!.transformToByteArray());
      const check =
        MAGIC_BYTES[res.ContentType as PhotoContentType] ?? (() => false);
      return head.length >= 12 && check(head);
    } catch {
      return false; // missing object or unreadable - either way, not linkable
    }
  }

  /**
   * List every object under a prefix, following pagination to the end (S3 caps a
   * page at 1000 keys). The GC sweep (ADR-0016) calls this per `<tenantId>/`
   * prefix - never the bare bucket - so it only ever sees objects it has
   * authority over. Safe on an empty prefix: `Contents` is absent, so we return
   * `[]`.
   */
  async listObjects(prefix: string): Promise<StorageObject[]> {
    const objects: StorageObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const o of page.Contents ?? []) {
        // A listed object always has a Key; Size/LastModified are typed optional
        // by the SDK. Default size 0 (harmless - never trips the oversize check);
        // leave lastModified undefined so the sweep treats it as too-new to
        // delete (conservative - an object we can't date, we don't reclaim).
        if (o.Key) {
          objects.push({
            key: o.Key,
            size: o.Size ?? 0,
            lastModified: o.LastModified,
          });
        }
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return objects;
  }

  /**
   * Batch-delete objects by key, chunked to the S3 1000-per-request cap. A
   * no-op on an empty list. Used by the GC sweep to reclaim orphans and evict
   * oversize objects.
   */
  async deleteObjects(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH_MAX) {
      const chunk = keys.slice(i, i + DELETE_BATCH_MAX);
      if (chunk.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
    }
  }

  /**
   * Dev-only bucket setup, applied idempotently on boot (STORAGE_BOOTSTRAP):
   * CORS so the SPA origin may PUT presigned uploads, and website access so
   * Garage's web endpoint serves photos anonymously. Prod (R2) is configured
   * once in its dashboard instead.
   */
  async applyDevBucketConfig(allowedOrigin: string): Promise<void> {
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [allowedOrigin],
              AllowedMethods: ['PUT'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    await this.client.send(
      new PutBucketWebsiteCommand({
        Bucket: this.bucket,
        WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } },
      }),
    );
  }
}
