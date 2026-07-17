/**
 * Demo photos for the seed (#46). Generated, not committed.
 *
 * The public property page's headline section is the gallery, and every seeded
 * property had zero photos - so `db:seed` + open the demo link showed a villa
 * with no pictures, which is half the feature missing from the one place anyone
 * looks at it.
 *
 * These are PLACEHOLDERS, and honestly so: tasteful gradients, not photographs.
 * Real villa shots would mean committing third-party images of someone else's
 * property into this repo, with the licensing question that carries. Generating
 * them instead keeps the repo free of binaries, makes the bytes deterministic
 * (so re-seeding is stable, like the fixed UUIDs), and still proves the whole
 * pipeline end to end: upload -> key on the row -> public URL -> <img> -> OG
 * image. Swap in real photos through the dashboard whenever you have them.
 *
 * PNG is hand-encoded because Node ships no image encoder and a dependency for
 * four demo gradients is a bad trade (invariant #8's spirit). A PNG is just:
 * signature, IHDR, IDAT (zlib-deflated scanlines), IEND - each chunk suffixed
 * with a CRC32. That is the whole format used here; no filters beyond "none".
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** A PNG chunk: length, type, data, CRC32 over (type + data). */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A diagonal two-colour gradient. Deterministic: same input, same bytes, so a
 * re-seed re-uploads an identical object rather than churning storage.
 */
export function gradientPng(
  width: number,
  height: number,
  from: [number, number, number],
  to: [number, number, number],
): Buffer {
  // Raw scanlines: each row is a filter byte (0 = none) then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      raw[p++] = Math.round(from[0] + (to[0] - from[0]) * t);
      raw[p++] = Math.round(from[1] + (to[1] - from[1]) * t);
      raw[p++] = Math.round(from[2] + (to[2] - from[2]) * t);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  // bytes 10-12 stay 0: deflate compression, adaptive filtering, no interlace.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Bali-ish palettes, one per demo property, so the pages look distinct. */
export const PALETTES: Record<string, [[number, number, number], [number, number, number]]> = {
  seminyak: [
    [56, 132, 189], // sea blue
    [244, 214, 175], // sand
  ],
  ubud: [
    [34, 94, 66], // jungle green
    [188, 208, 140], // rice terrace
  ],
};
