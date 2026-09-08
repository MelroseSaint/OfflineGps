// Generates PWA icons without any native image dependencies.
// Usage: node scripts/make-icons.mjs  (npm run icons)
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BG = { r: 11, g: 18, b: 32 }; // #0b1220
const ACCENT = { r: 245, g: 166, b: 35 }; // amber
const WHITE = { r: 255, g: 255, b: 255 };

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function inRoundedRect(x, y, w, h, r) {
  if (x < r && y < r) return Math.hypot(r - x, r - y) <= r;
  if (x >= w - r && y < r) return Math.hypot(x - (w - r - 1), r - y) <= r;
  if (x < r && y >= h - r) return Math.hypot(r - x, y - (h - r - 1)) <= r;
  if (x >= w - r && y >= h - r) return Math.hypot(x - (w - r - 1), y - (h - r - 1)) <= r;
  return true;
}

function inTriangle(px, py, t) {
  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  const d1 = sign(px, py, t[0][0], t[0][1], t[1][0], t[1][1]);
  const d2 = sign(px, py, t[1][0], t[1][1], t[2][0], t[2][1]);
  const d3 = sign(px, py, t[2][0], t[2][1], t[0][0], t[0][1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Normalized design coordinates (0..1): a winding route with an arrow tip.
const ROUTE = [
  [0.22, 0.78],
  [0.36, 0.74],
  [0.42, 0.6],
  [0.54, 0.55],
  [0.62, 0.4],
  [0.68, 0.3],
];
const ARROW = [
  [0.78, 0.16],
  [0.82, 0.38],
  [0.64, 0.31],
];

function drawIcon(size, maskable) {
  const png = new PNG({ width: size, height: size });
  const s = size / 512;
  const routeW = Math.max(2, 26 * s * (maskable ? 0.82 : 1));
  // Scale + center geometry for maskable safe zone.
  const pad = maskable ? 0.1 : 0;
  const map = (p) => [(p[0] * (1 - 2 * pad) + pad) * size, (p[1] * (1 - 2 * pad) + pad) * size];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      let color = null;
      if (maskable || inRoundedRect(x, y, size, size, Math.round(96 * s))) {
        color = BG;
        // route line
        for (let i = 0; i < ROUTE.length - 1; i++) {
          const a = map(ROUTE[i]);
          const b = map(ROUTE[i + 1]);
          if (distToSeg(x, y, a[0], a[1], b[0], b[1]) <= routeW / 2) color = ACCENT;
        }
        const c0 = map(ROUTE[ROUTE.length - 1]);
        const c1 = map(ROUTE[4]);
        if (distToSeg(x, y, c0[0], c0[1], c1[0], c1[1]) <= routeW / 2) color = ACCENT;
        // arrow tip
        const tri = ARROW.map(map);
        if (inTriangle(x, y, tri)) color = WHITE;
        // puck
        const pc = map(ROUTE[0]);
        const r = Math.max(3, 16 * s * (maskable ? 0.82 : 1));
        if (Math.hypot(x - pc[0], y - pc[1]) <= r) color = WHITE;
      }
      if (color) {
        png.data[idx] = color.r;
        png.data[idx + 1] = color.g;
        png.data[idx + 2] = color.b;
        png.data[idx + 3] = 255;
      } else {
        png.data[idx + 3] = 0;
      }
    }
  }
  return PNG.sync.write(png);
}

mkdirSync(new URL('../public/icons', import.meta.url), { recursive: true });
const out = (name, buf) =>
  writeFileSync(new URL(`../public/icons/${name}`, import.meta.url), buf);
out('icon-72.png', drawIcon(72, false));
out('icon-96.png', drawIcon(96, false));
out('icon-128.png', drawIcon(128, false));
out('icon-144.png', drawIcon(144, false));
out('icon-152.png', drawIcon(152, false));
out('icon-192.png', drawIcon(192, false));
out('icon-384.png', drawIcon(384, false));
out('icon-512.png', drawIcon(512, false));
out('icon-maskable-512.png', drawIcon(512, true));
out('apple-touch-icon.png', drawIcon(180, false));
console.log('icons written to public/icons');
