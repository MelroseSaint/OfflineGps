// Pure spherical/planar geometry helpers used across routing, caching and navigation.
export type LngLat = [number, number]; // [lng, lat]

const R = 6371008.8; // mean earth radius, meters
const DEG = Math.PI / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLng = (b[0] - a[0]) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearingDeg(a: LngLat, b: LngLat): number {
  const φ1 = a[1] * DEG;
  const φ2 = b[1] * DEG;
  const Δλ = (b[0] - a[0]) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  let d = ((b - a + 540) % 360) - 180; // -180..180
  if (d === -180) d = 180;
  return d;
}

/** Destination point given start, bearing (deg) and distance (m). */
export function destination(from: LngLat, bearing: number, distM: number): LngLat {
  const δ = distM / R;
  const θ = bearing * DEG;
  const φ1 = from[1] * DEG;
  const λ1 = from[0] * DEG;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return [(λ2 / DEG + 540) % 360 - 180, φ2 / DEG];
}

/** Equirectangular approximation — fine for sub-km projection work. */
function toXY(p: LngLat, ref: LngLat): [number, number] {
  const x = (p[0] - ref[0]) * DEG * R * Math.cos(ref[1] * DEG);
  const y = (p[1] - ref[1]) * DEG * R;
  return [x, y];
}

export interface Projection {
  /** Index of segment start vertex. */
  index: number;
  t: number;
  /** Projected point. */
  point: LngLat;
  /** Distance from query point to the projected point, meters. */
  distM: number;
  /** Cumulative distance along the polyline up to the projection, meters. */
  alongM: number;
}

/** Project a point onto a polyline; returns nearest segment info. */
export function projectOntoPath(pt: LngLat, path: LngLat[]): Projection | null {
  if (path.length === 0) return null;
  if (path.length === 1) {
    return { index: 0, t: 0, point: path[0], distM: haversineM(pt, path[0]), alongM: 0 };
  }
  const ref = pt;
  const [qx, qy] = toXY(pt, ref);
  let best: Projection | null = null;
  let cumulative = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const segLen = haversineM(a, b);
    const [ax, ay] = toXY(a, ref);
    const [bx, by] = toXY(b, ref);
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((qx - ax) * dx + (qy - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const dist = Math.hypot(qx - px, qy - py);
    if (!best || dist < best.distM) {
      const pLngLat: LngLat = [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
      ];
      best = {
        index: i,
        t,
        point: pLngLat,
        distM: dist,
        alongM: cumulative + t * segLen,
      };
    }
    cumulative += segLen;
  }
  return best;
}

/** Point-to-segment distance in meters (equirectangular approximation). */
export function pointSegmentDistM(p: LngLat, a: LngLat, b: LngLat): number {
  const px = p[0] * 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const py = p[1] * 111_320;
  const ax = a[0] * 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ay = a[1] * 111_320;
  const bx = b[0] * 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const by = b[1] * 111_320;
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pathLengthM(path: LngLat[]): number {
  let d = 0;
  for (let i = 0; i < path.length - 1; i++) d += haversineM(path[i], path[i + 1]);
  return d;
}

/** Ramer–Douglas–Peucker simplification with tolerance in meters. */
export function simplifyPath(path: LngLat[], toleranceM: number): LngLat[] {
  if (path.length <= 2) return path.slice();
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    let maxD = -1;
    let maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const pr = projectOntoPath(path[i], [path[lo], path[hi]]);
      const d = pr ? pr.distM : 0;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > toleranceM && maxI > 0) {
      keep[maxI] = 1;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  return path.filter((_, i) => keep[i]);
}

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export function bboxOf(points: LngLat[]): BBox {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of points) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/** Pad a bbox by meters (crude, slightly over-padded at high latitudes — safe). */
export function padBBox(b: BBox, meters: number): BBox {
  const dLat = (meters / R) / DEG;
  const dLng = dLat / Math.max(0.05, Math.cos((((b.minLat + b.maxLat) / 2) * DEG)));
  return {
    minLng: b.minLng - dLng,
    minLat: b.minLat - dLat,
    maxLng: b.maxLng + dLng,
    maxLat: b.maxLat + dLat,
  };
}

/** Minimum distance in meters between a segment and a lat/lng bbox (0 if intersecting). */
export function segmentBBoxDistM(a: LngLat, b: LngLat, box: BBox): number {
  const latMin = Math.min(a[1], b[1]);
  const latMax = Math.max(a[1], b[1]);
  const lngMin = Math.min(a[0], b[0]);
  const lngMax = Math.max(a[0], b[0]);
  const dLat = Math.max(box.minLat - latMax, latMin - box.maxLat, 0);
  const dLng = Math.max(box.minLng - lngMax, lngMin - box.maxLng, 0);
  if (dLat === 0 && dLng === 0) return 0;
  const midLat = (Math.max(box.minLat, latMin) + Math.min(box.maxLat, latMax)) / 2;
  return Math.hypot(dLat * R, dLng * R * Math.cos(midLat * DEG));
}
