// Generates build/icon.png (512x512): the Plexus mark (a hub node linked to three satellites,
// same geometry as ui/public/plexus.svg) on a dark rounded square.
// No image libraries: raw RGBA pixels, zlib-compressed into a PNG by hand.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const S = 512;
const px = Buffer.alloc(S * S * 4);

const bg = [20, 20, 21], node = [237, 237, 237], edge = [161, 161, 166];
const radius = 96; // corner radius of the background square
// The mark lives in a 16x16 viewBox; map it onto the middle of the icon.
const scale = 22, off = S / 2 - 8 * scale;
const P = (x, y) => [off + x * scale, off + y * scale];
const nodes = [[8, 8, 2], [2.5, 3.5, 1.25], [13.5, 4, 1.25], [12, 13, 1.25]].map(([x, y, r]) => [...P(x, y), r * scale]);
const edges = [[3.5, 4.3, 6.4, 7], [12.4, 4.7, 9.6, 7], [11.2, 12.1, 9.4, 9.4]].map(([a, b, c, d]) => [...P(a, b), ...P(c, d)]);
const edgeW = 1.1 * scale;

/** Coverage (0..1) of a pixel by a shape given its signed distance, for cheap anti-aliasing. */
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d));
/** Distance from (x, y) to the segment (ax, ay)-(bx, by). */
const segDist = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};
const mix = (c, col, k) => [c[0] + (col[0] - c[0]) * k, c[1] + (col[1] - c[1]) * k, c[2] + (col[2] - c[2]) * k];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    // rounded-square signed distance
    const qx = Math.abs(cx - S / 2) - (S / 2 - radius - 8), qy = Math.abs(cy - S / 2) - (S / 2 - radius - 8);
    const dSq = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    const a = cover(dSq);
    let c = bg;
    for (const [ax, ay, bx, by] of edges) c = mix(c, edge, cover(segDist(cx, cy, ax, ay, bx, by) - edgeW / 2));
    for (const [nx, ny, r] of nodes) c = mix(c, node, cover(Math.hypot(cx - nx, cy - ny) - r));
    const i = (y * S + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = Math.round(a * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

const out = join(import.meta.dirname, '..', 'build');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.png'), png);
console.log(`wrote ${join(out, 'icon.png')}`);
