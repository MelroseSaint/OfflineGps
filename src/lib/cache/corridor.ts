import { pathLengthM, pointSegmentDistM, bboxOf, padBBox, type LngLat } from '../geo';
import { lngLatToTile, tileToLngLatBounds, tileWidthM, type TileCoord } from '../tiles';
import type { RouteStep } from '../types';

export interface CorridorOptions {
  corridorM: number;
  detailRadiusM: number;
  routeCaching: boolean;
}

export interface CorridorPlan {
  /** z13 tiles forming the route corridor. */
  corridor: TileCoord[];
  /** z14 tiles around start/end/maneuver points. */
  detail: TileCoord[];
  /** Low-zoom tiles so the route overview renders offline. */
  overview: TileCoord[];
}

function tileBoundsBox(t: TileCoord): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
  const { sw, ne } = tileToLngLatBounds(t);
  return { minLng: sw[0], minLat: sw[1], maxLng: ne[0], maxLat: ne[1] };
}

/**
 * Tiles at zoom z whose center lies within radiusM (+ half a tile, so every
 * tile the line passes through is included) of the polyline. Uses a bbox
 * broad phase and shrinks the radius if the result would exceed cap.
 */
export function corridorTiles(
  points: LngLat[],
  z: number,
  radiusM: number,
  cap: number,
): TileCoord[] {
  if (points.length < 2) return [];
  let radius = radiusM;
  for (;;) {
    const found = new Map<string, TileCoord>();
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const box = padBBox(bboxOf([a, b]), radius * 2);
      // Broad phase: tiles of the inflated segment bbox.
      const t0 = lngLatToTile([box.minLng, box.maxLat], z);
      const t1 = lngLatToTile([box.maxLng, box.minLat], z);
      const { sw, ne } = tileToLngLatBounds({ z, x: 0, y: 0 });
      const halfTile = Math.abs(ne[0] - sw[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180) / 2;
      for (let x = t0.x; x <= t1.x; x++) {
        for (let y = t0.y; y <= t1.y; y++) {
          const t: TileCoord = { z, x: ((x % 2 ** z) + 2 ** z) % 2 ** z, y: Math.max(0, y) };
          const c = tileCenterOf(t);
          if (pointSegmentDistM(c, a, b) <= radius + halfTile) {
            found.set(`${t.x}/${t.y}`, t);
          }
        }
      }
      if (found.size > cap * 3) break; // way too big — shrink early
    }
    if (found.size <= cap || radius <= 200) return [...found.values()];
    radius = Math.max(200, radius * 0.55);
  }
}

function tileCenterOf(t: TileCoord): LngLat {
  const { sw, ne } = tileToLngLatBounds(t);
  return [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2];
}

/** Point at a given distance along the polyline. */
export function pointAtDistance(points: LngLat[], distM: number): LngLat {
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const R = 6371008.8;
    const dLat = (b[1] - a[1]) * (Math.PI / 180);
    const dLng = (b[0] - a[0]) * (Math.PI / 180) * Math.cos((a[1] * Math.PI) / 180);
    const seg = Math.sqrt(dLat * dLat + dLng * dLng) * R;
    if (acc + seg >= distM) {
      const t = seg === 0 ? 0 : (distM - acc) / seg;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    acc += seg;
  }
  return points[points.length - 1];
}

/** Route sub-polyline between two distances along it. */
export function sliceRoute(points: LngLat[], fromM: number, toM: number): LngLat[] {
  const total = pathLengthM(points);
  const start = Math.max(0, Math.min(fromM, total));
  const end = Math.max(start, Math.min(toM, total));
  const out: LngLat[] = [pointAtDistance(points, start)];
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const R = 6371008.8;
    const dLat = (b[1] - a[1]) * (Math.PI / 180);
    const dLng = (b[0] - a[0]) * (Math.PI / 180) * Math.cos((a[1] * Math.PI) / 180);
    const seg = Math.sqrt(dLat * dLat + dLng * dLng) * R;
    if (acc + seg > start && acc < end) out.push(b);
    acc += seg;
    if (acc >= end) break;
  }
  return out;
}

/**
 * Full corridor plan for a freshly calculated route:
 *  - overview zooms (6–12) sampled along the whole route (cheap, tiny tiles);
 *  - z13 corridor at corridorM half-width (storage-capped);
 *  - z14 detail around origin, destination and every maneuver point.
 */
export function planCorridor(points: LngLat[], steps: RouteStep[], opts: CorridorOptions): CorridorPlan {
  const total = pathLengthM(points);
  const avgLat = points.reduce((s, p) => s + p[1], 0) / points.length;

  // Overview zooms — sample at half-tile spacing.
  const overview: TileCoord[] = [];
  const seen = new Set<string>();
  for (let z = 6; z <= 12; z++) {
    const tw = tileWidthM({ z }, avgLat);
    const n = Math.max(1, Math.ceil(total / (tw * 0.5)));
    for (let i = 0; i <= n; i++) {
      const p = pointAtDistance(points, (i / n) * total);
      const t = lngLatToTile(p, z);
      const k = `${t.x}/${t.y}`;
      if (!seen.has(k)) {
        seen.add(k);
        overview.push(t);
      }
    }
  }

  // Corridor.
  const corridor = opts.routeCaching
    ? corridorTiles(points, 13, opts.corridorM, 1400)
    : [];

  // Detail anchors: origin, destination, maneuver points. Degenerate
  // two-point segments keep corridorTiles' segment-distance math correct.
  const anchors: LngLat[] = [points[0], points[points.length - 1]];
  for (const s of steps) {
    if (s.type !== 'depart' && s.type !== 'arrive') anchors.push(s.location);
  }
  const detail = anchors.length
    ? corridorTiles(anchors.flatMap((p) => [p, p]), 14, opts.detailRadiusM, 500)
    : [];

  return { corridor, detail: dedupeTiles(detail), overview };
}

function dedupeTiles(tiles: TileCoord[]): TileCoord[] {
  const m = new Map<string, TileCoord>();
  for (const t of tiles) m.set(`${t.z}/${t.x}/${t.y}`, t);
  return [...m.values()];
}

/**
 * Predictive caching while navigating: the high-detail (z14) area the user
 * will reach within `lookaheadS` seconds at their current pace.
 */
export function planPredictive(
  points: LngLat[],
  alongM: number,
  speedMps: number,
  opts: { detailRadiusM: number; lookaheadS?: number },
): TileCoord[] {
  const lookaheadS = opts.lookaheadS ?? 480; // ~8 minutes ahead
  const aheadDist = Math.max(opts.detailRadiusM * 3, speedMps * lookaheadS);
  const seg = sliceRoute(points, alongM - opts.detailRadiusM, alongM + aheadDist);
  if (seg.length < 2) return [];
  return corridorTiles(seg, 14, opts.detailRadiusM, 400);
}
