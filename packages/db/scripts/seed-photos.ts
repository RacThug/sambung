/**
 * Upload the seed's demo photos to object storage (#39's Garage in dev).
 *
 * `db:seed` needed only Postgres before this. It still does: if storage is
 * unreachable or unconfigured, this WARNS and returns nothing, and the seed
 * completes with photo-less properties exactly as it used to. A demo nicety must
 * never be able to fail the thing that makes the database usable.
 *
 * Keys are deterministic and match the `<tenantId>/<propertyId>/` prefix the API
 * enforces on PATCH /photos (api-spec §4.5), so a seeded gallery behaves like an
 * uploaded one - the owner can reorder or delete these from the dashboard.
 */
import {
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { gradientPng, PALETTES } from "./photo-fixtures";

export interface SeedPhotoSpec {
  tenantId: string;
  propertyId: string;
  palette: keyof typeof PALETTES;
  /** How many photos: one hero + (count - 1) thumbnails. */
  count: number;
}

function client(): { s3: S3Client; bucket: string } | null {
  const {
    STORAGE_ENDPOINT,
    STORAGE_REGION,
    STORAGE_BUCKET,
    STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY,
  } = process.env;
  if (
    !STORAGE_ENDPOINT ||
    !STORAGE_BUCKET ||
    !STORAGE_ACCESS_KEY_ID ||
    !STORAGE_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  const config: S3ClientConfig = {
    endpoint: STORAGE_ENDPOINT,
    region: STORAGE_REGION ?? "garage",
    // Garage serves the S3 API path-style; virtual-host addressing would
    // resolve <bucket>.localhost and fail.
    forcePathStyle: true,
    credentials: {
      accessKeyId: STORAGE_ACCESS_KEY_ID,
      secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
    },
  };
  return { s3: new S3Client(config), bucket: STORAGE_BUCKET };
}

/**
 * Returns keys per property id, or an empty map if storage isn't available.
 * Never throws: the caller treats photos as optional.
 */
export async function uploadSeedPhotos(
  specs: SeedPhotoSpec[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const conn = client();
  if (!conn) {
    console.warn(
      "Photos skipped: STORAGE_* not configured. Copy packages/db/.env.example " +
        "to .env for the demo gallery; the seed is otherwise complete.",
    );
    return result;
  }

  try {
    for (const spec of specs) {
      const [from, to] = PALETTES[spec.palette];
      const keys: string[] = [];
      for (let i = 0; i < spec.count; i++) {
        // Generated at the 3:2 the gallery renders them at, so object-cover
        // has nothing to crop and the demo shows the real framing.
        const png =
          i === 0
            ? gradientPng(1200, 800, from, to)
            : gradientPng(600, 400, ...slice(from, to, i));
        const key = `${spec.tenantId}/${spec.propertyId}/seed-${i + 1}.png`;
        await conn.s3.send(
          new PutObjectCommand({
            Bucket: conn.bucket,
            Key: key,
            Body: png,
            ContentType: "image/png",
          }),
        );
        keys.push(key);
      }
      result.set(spec.propertyId, keys);
    }
    console.log(
      `Photos: uploaded ${[...result.values()].flat().length} demo images.`,
    );
  } catch (e) {
    // Storage down, bucket missing, wrong keys - all the same to the seed.
    // `name` as well as `message`: an SDK connection error often carries an
    // empty message, and "Photos skipped:" followed by nothing is a warning
    // nobody can act on.
    const why =
      e instanceof Error ? `${e.name}: ${e.message || "no detail"}` : String(e);
    console.warn(
      `Photos skipped (storage unreachable) - ${why}\n` +
        "The seed is otherwise complete. Run `docker compose up -d` and " +
        "re-seed for the demo gallery.",
    );
    return new Map();
  }
  return result;
}

/**
 * A thumbnail's colours: a narrow SLICE of the property's own gradient, walked
 * along by index, so each tile differs from its neighbours while staying in the
 * same family as the hero.
 *
 * The first attempt nudged channels independently (r+d, g-d, b+d), which for the
 * seminyak palette turned sea-blue and sand into purple and pink - thumbnails
 * that looked like a different villa sitting under the hero. Interpolating
 * between the palette's own two colours cannot leave the family, by construction.
 */
function slice(
  from: [number, number, number],
  to: [number, number, number],
  i: number,
): [[number, number, number], [number, number, number]] {
  const lerp = (t: number): [number, number, number] => [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
  // Tile i spans [start, start + 0.4] of the gradient, wrapped into [0, 0.6].
  const start = ((i - 1) * 0.2) % 0.6;
  return [lerp(start), lerp(start + 0.4)];
}
