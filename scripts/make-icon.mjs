// Generates resources/icon.png (512), icon.ico (16-256) and tray icons with no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'resources');
fs.mkdirSync(out, { recursive: true });

function crc32(buf) {
  let c;
  const table = (crc32.t ||= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// signed distance to rounded rectangle centered at (cx,cy)
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function render(size, { tray = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4; // supersampling
  const u = size / 512;
  // candles: [x, bodyTop, bodyBottom, wickTop, wickBottom, up]
  const candles = [
    [150, 250, 360, 205, 395, false],
    [256, 170, 300, 125, 340, true],
    [362, 110, 240, 70, 280, true],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = (x + (sx + 0.5) / S) / u;
          const py = (y + (sy + 0.5) / S) / u;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          if (!tray) {
            const d = sdRoundRect(px, py, 256, 256, 236, 236, 112);
            if (d <= 0) {
              // gradient background: deep indigo -> teal
              const tt = (px + py) / 1024;
              cr = 30 + (20 - 30) * tt;
              cg = 41 + (184 - 41) * tt;
              cb = 112 + (166 - 112) * tt;
              ca = 255;
            }
          }
          for (const [cx, bt, bb, wt, wb, up] of candles) {
            const inWick = Math.abs(px - cx) <= 9 && py >= wt && py <= wb;
            const inBody = sdRoundRect(px, py, cx, (bt + bb) / 2, 34, (bb - bt) / 2, 10) <= 0;
            if (inWick || inBody) {
              if (tray) {
                cr = 255; cg = 255; cb = 255; ca = 255;
              } else {
                const c = up ? [255, 255, 255] : [255, 255, 255];
                const alpha = up ? 1 : 0.62;
                cr = cr * (1 - alpha) + c[0] * alpha;
                cg = cg * (1 - alpha) + c[1] * alpha;
                cb = cb * (1 - alpha) + c[2] * alpha;
                ca = 255;
              }
            }
          }
          r += cr * (ca / 255);
          g += cg * (ca / 255);
          b += cb * (ca / 255);
          a += ca;
        }
      }
      const n = S * S;
      const A = a / n;
      const i = (y * size + x) * 4;
      buf[i] = A ? Math.round((r / n) * (255 / A)) : 0;
      buf[i + 1] = A ? Math.round((g / n) * (255 / A)) : 0;
      buf[i + 2] = A ? Math.round((b / n) * (255 / A)) : 0;
      buf[i + 3] = Math.round(A);
    }
  }
  return png(size, size, buf);
}

fs.writeFileSync(path.join(out, 'icon.png'), render(512));
fs.writeFileSync(path.join(out, 'tray.png'), render(32));
fs.writeFileSync(path.join(out, 'tray@2x.png'), render(64));
fs.writeFileSync(path.join(out, 'trayTemplate.png'), render(22, { tray: true }));

// ICO with embedded PNGs
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => render(s));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const e = i * 16;
  dir[e] = s >= 256 ? 0 : s;
  dir[e + 1] = s >= 256 ? 0 : s;
  dir[e + 2] = 0;
  dir[e + 3] = 0;
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(pngs[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, dir, ...pngs]));
console.log('icons written to', out);
