import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
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
