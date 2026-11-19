// Generates build/icon.png (512x512): a dark rounded square with a hexagonal network of dots.
// No image libraries: raw RGBA pixels, zlib-compressed into a PNG by hand.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const S = 512;
const px = Buffer.alloc(S * S * 4);

const bg = [31, 36, 48], dot = [245, 165, 36], dotSoft = [120, 170, 255];
const radius = 96; // corner radius of the background square
const dots = [[0, 0, 62, dot]];
for (let i = 0; i < 6; i++) {
  const a = (Math.PI / 3) * i - Math.PI / 2;
  dots.push([Math.cos(a) * 150, Math.sin(a) * 150, 42, i % 2 ? dotSoft : dot]);
}

/** Coverage (0..1) of a pixel by a shape given its signed distance, for cheap anti-aliasing. */
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d));

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    // rounded-square signed distance
    const qx = Math.abs(cx - S / 2) - (S / 2 - radius - 8), qy = Math.abs(cy - S / 2) - (S / 2 - radius - 8);
    const dSq = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    let a = cover(dSq);
    let [r, g, b] = bg;
    for (const [ox, oy, rad, col] of dots) {
      const c = cover(Math.hypot(cx - (S / 2 + ox), cy - (S / 2 + oy)) - rad);
      r = r + (col[0] - r) * c; g = g + (col[1] - g) * c; b = b + (col[2] - b) * c;
    }
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = Math.round(a * 255);
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
