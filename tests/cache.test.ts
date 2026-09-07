import { describe, expect, it } from 'vitest';
import { corridorTiles, planCorridor, planPredictive, pointAtDistance } from '../src/lib/cache/corridor';
import { planEviction, tileCenterLngLat, type EvictMeta } from '../src/lib/cache/budget';
import type { RouteStep } from '../src/lib/types';

// Straight ~105 km route at latitude 40.
const ROUTE: [number, number][] = [
  [-77.0, 40.0],
  [-76.0, 40.28],
];

const STEPS: RouteStep[] = [
  { type: 'depart', name: '', location: ROUTE[0], distanceM: 0, durationS: 0, cumDistM: 0, cumDurS: 0, pointIndex: 0 },
  { type: 'turn', modifier: 'left', name: 'PA 230', location: [-76.6, 40.18], distanceM: 0, durationS: 0, cumDistM: 45000, cumDurS: 2500, pointIndex: 1 },
  { type: 'arrive', name: '', location: ROUTE[1], distanceM: 0, durationS: 0, cumDistM: 105000, cumDurS: 5200, pointIndex: 2 },
];

describe('corridor planning', () => {
  it('returns corridor tiles along the route at z13', () => {
    const tiles = corridorTiles(ROUTE, 13, 2000, 1400);
    expect(tiles.length).toBeGreaterThan(15);
    expect(tiles.length).toBeLessThan(400);
    // Every tile center must be within radius + tile half-diagonal of the route.
    for (const t of tiles) {
      const c = tileCenterLngLat(t);
      const d = distToRoute(c, ROUTE);
      expect(d).toBeLessThan(2000 + 3500);
    }
  });

  it('shrinks radius when the corridor would exceed the cap', () => {
    const unconstrained = corridorTiles(ROUTE, 13, 2000, 10_000);
    const capped = corridorTiles(ROUTE, 13, 2000, 30);
    // The cap is a strong pressure valve: far fewer tiles, and the radius
    // floor means it may not hit the cap exactly, but it must shrink a lot.
    expect(capped.length).toBeLessThan(unconstrained.length);
    expect(capped.length).toBeLessThanOrEqual(48);
    // Capped corridor tiles are still near the route.
    for (const t of capped) {
      const d = distToRoute(tileCenterLngLat(t), ROUTE);
      expect(d).toBeLessThan(6000);
    }
  });

  it('planCorridor: overview + corridor + detail near anchors', () => {
    const plan = planCorridor(ROUTE, STEPS, {
      corridorM: 2000,
      detailRadiusM: 2000,
      routeCaching: true,
    });
    expect(plan.overview.length).toBeGreaterThan(30);
    const zs = new Set(plan.overview.map((t) => t.z));
    expect(zs.has(6)).toBe(true);
    expect(zs.has(12)).toBe(true);
    expect(plan.corridor.length).toBeGreaterThan(15);
    // Detail tiles exist near the start point and the maneuver point.
    const nearStart = plan.detail.some((t) => distToRoute(tileCenterLngLat(t), [ROUTE[0], ROUTE[0]]) < 3000);
    expect(nearStart).toBe(true);
  });

  it('planCorridor: routeCaching=false yields no corridor', () => {
    const plan = planCorridor(ROUTE, STEPS, {
      corridorM: 2000,
      detailRadiusM: 2000,
      routeCaching: false,
    });
    expect(plan.corridor.length).toBe(0);
    expect(plan.overview.length).toBeGreaterThan(0);
  });

  it('planPredictive covers ahead of the user, not behind', () => {
    const ahead = planPredictive(ROUTE, 20_000, 25, { detailRadiusM: 1500 });
    expect(ahead.length).toBeGreaterThan(0);
    for (const t of ahead) {
      const c = tileCenterLngLat(t);
      // Nothing far behind the 20 km mark.
      const along = nearestAlong(c, ROUTE);
      expect(along).toBeGreaterThan(15_000);
    }
  });

  it('pointAtDistance interpolates monotonically', () => {
    const p1 = pointAtDistance(ROUTE, 0);
    const p2 = pointAtDistance(ROUTE, 50_000);
    const p3 = pointAtDistance(ROUTE, 1e9);
    expect(p1[0]).toBeCloseTo(-77.0, 3);
    expect(p2[0]).toBeGreaterThan(p1[0]); // route runs west → east
    expect(p3[0]).toBeCloseTo(-76.0, 3);
  });
});

// ---- eviction ---------------------------------------------------------------

function meta(partial: Partial<EvictMeta>): EvictMeta {
  return {
    key: partial.key ?? 'planet/13/0/0',
    tier: partial.tier ?? 'smart',
    size: partial.size ?? 100_000,
    lastAccess: partial.lastAccess ?? 1000,
    pinnedBy: partial.pinnedBy,
    z: partial.z ?? 13,
    x: partial.x ?? 0,
    y: partial.y ?? 0,
  };
}

// Corridor tiles along ROUTE (tile centers ~1km from the line).
function corridorMeta(x: number, y: number, extra: Partial<EvictMeta> = {}): EvictMeta {
  return meta({ key: `planet/13/${x}/${y}`, z: 13, x, y, pinnedBy: 'route-1', ...extra });
}

function findCorridorTile(alongFrac: number): { z: number; x: number; y: number } {
  // Walk along the route to find a z13 tile that lies within the corridor.
  const t = pointAtDistance(ROUTE, alongFrac * 105_000);
  return { z: 13, x: lngToTileX(t[0], 13), y: lngToTileY(t[1], 13) };
}

function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function lngToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

describe('eviction policy', () => {
  const ctxBase = {
    budgetBytes: 500_000,
    autoCleanup: true,
    nowMs: 2000,
    route: ROUTE,
    posAlongM: 50_000,
    corridorM: 2000,
    keepBehindM: 5000,
  };

  it('evicts oldest-first until within budget', () => {
    const metas = Array.from({ length: 10 }, (_, i) =>
      meta({ key: `planet/13/${i}/0`, size: 100_000, lastAccess: i * 100 }),
    );
    const plan = planEviction(metas, ctxBase);
    // 1,000,000 bytes used, budget 500k → target 450k → evict 6 oldest.
    expect(plan.evict.length).toBe(6);
    expect(plan.evict).toContain('planet/13/0/0');
    expect(plan.evict).not.toContain('planet/13/9/0');
    expect(plan.remainingBytes).toBeLessThanOrEqual(450_000);
    expect(plan.pressure).toBe('critical');
  });

  it('never evicts permanent tiles', () => {
    const metas = [
      meta({ key: 'p1', tier: 'permanent', size: 900_000, lastAccess: 0 }),
      meta({ key: 's1', size: 600_000, lastAccess: 100 }),
    ];
    const plan = planEviction(metas, ctxBase);
    expect(plan.evict).toEqual(['s1']);
    expect(plan.remainingBytes).toBe(0);
  });

  it('protects the active route corridor ahead of the user', () => {
    const aheadTile = findCorridorTile(0.7); // ~73km — ahead of 50km progress
    const behindTile = findCorridorTile(0.1); // ~10km — far behind
    const offRouteTile = meta({ key: 'planet/13/999/999', size: 100_000, lastAccess: 100 });
    const metas = [
      corridorMeta(aheadTile.x, aheadTile.y, { size: 100_000, lastAccess: 100 }),
      corridorMeta(behindTile.x, behindTile.y, { size: 100_000, lastAccess: 200 }),
      offRouteTile,
      meta({ key: 'planet/13/50/50', size: 300_000, lastAccess: 300 }),
    ];
    const plan = planEviction(metas, ctxBase);
    expect(plan.evict).not.toContain(`planet/13/${aheadTile.x}/${aheadTile.y}`);
    // The behind tile is pinned but outside the keep-behind window → evictable.
    expect(plan.evict).toContain(`planet/13/${behindTile.x}/${behindTile.y}`);
    // Off-route unpinned old tiles go first regardless.
    expect(plan.evict[0]).toBe('planet/13/999/999');
  });

  it('respects autoCleanup=false (reports pressure only)', () => {
    const metas = [meta({ size: 900_000, lastAccess: 0 })];
    const plan = planEviction(metas, { ...ctxBase, autoCleanup: false });
    expect(plan.evict).toEqual([]);
    expect(plan.pressure).toBe('critical');
  });

  it('reports ok pressure under budget', () => {
    const metas = [meta({ size: 100_000, lastAccess: 1 })];
    const plan = planEviction(metas, ctxBase);
    expect(plan.pressure).toBe('ok');
    expect(plan.evict).toEqual([]);
  });
});

// ---- helpers ----------------------------------------------------------------

function distToRoute(p: [number, number], route: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const d = distToSegment(p, route[i], route[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  // Equirectangular approx, meters.
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

function nearestAlong(p: [number, number], route: [number, number][]): number {
  // Straight two-point route: project onto the segment in equirectangular
  // meters and return the distance along it.
  const a = route[0];
  const b = route[1];
  const px = p[0] * 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const py = p[1] * 111_320;
  const ax = a[0] * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  const ay = a[1] * 111_320;
  const bx = b[0] * 111_320 * Math.cos((b[1] * Math.PI) / 180);
  const by = b[1] * 111_320;
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return t * 105_000;
}

function approxAlong(route: [number, number][], q: [number, number]): number {
  // Fraction of the straight-line route length.
  const total = Math.hypot(
    (route[1][0] - route[0][0]) * 111_320 * Math.cos((route[0][1] * Math.PI) / 180),
    (route[1][1] - route[0][1]) * 111_320,
  );
  const along = Math.hypot(
    (q[0] - route[0][0]) * 111_320 * Math.cos((route[0][1] * Math.PI) / 180),
    (q[1] - route[0][1]) * 111_320,
  );
  return (along / total) * 105_000;
}
