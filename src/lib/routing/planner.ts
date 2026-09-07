import { bboxOf, haversineM, padBBox, type LngLat } from '../geo';
import { tileKey, tilesInBBox, type TileCoord } from '../tiles';
import { cacheClient } from '../cache/cacheClient';
import { tileProvider } from '../cache/tileProvider';
import { planCorridor } from '../cache/corridor';
import { settings } from '../settings';
import { router, type RouteResult } from './routerClient';
import type { Route } from '../types';

export interface PlanProgress {
  phase: 'coarse' | 'corridor' | 'done';
  done: number;
  total: number;
}

export type PlanResult =
  | { ok: true; route: Route }
  | { ok: false; error: string };

const COARSE_CAP = 900;

/**
 * planRoute — compute a route **locally** using a two-phase strategy:
 *
 *  1. Coarse pass: fetch road tiles over the origin/destination bounding box
 *     at a zoom matched to trip length, build the graph in the worker, run A*.
 *  2. Corridor pass: compute the route corridor from the coarse geometry,
 *     fetch z13 corridor tiles + z14 detail tiles, rebuild, re-route at full
 *     detail.
 *
 * No routing service is contacted — the network is only ever used to fetch
 * vector tiles. Once cached, the same corridor supports fully-offline rerouting.
 */
export async function planRoute(
  origin: LngLat,
  dest: LngLat,
  onProgress?: (p: PlanProgress) => void,
): Promise<PlanResult> {
  const s = settings.get();
  const direct = haversineM(origin, dest);

  // ---- Phase 1: coarse graph over the trip bbox ---------------------------
  let coarseZ = direct > 150_000 ? 11 : direct > 40_000 ? 12 : 13;
  const box = padBBox(bboxOf([origin, dest]), Math.max(3000, direct * 0.08));
  let coarseTiles = tilesInBBox(box, coarseZ);
  while (coarseTiles.length > COARSE_CAP && coarseZ > 8) {
    coarseZ -= 1;
    coarseTiles = tilesInBBox(box, coarseZ);
  }
  if (coarseTiles.length > COARSE_CAP * 3) {
    return { ok: false, error: 'Trip too long for initial download. Try a nearer destination.' };
  }
  const coarseKeys = coarseTiles.map((t) => tileKey(t));
  onProgress?.({ phase: 'coarse', done: 0, total: coarseKeys.length });
  const coarseData = await tileProvider.obtainMany(coarseKeys, (done, total) =>
    onProgress?.({ phase: 'coarse', done, total }),
  );
  if (coarseData.size === 0) {
    return { ok: false, error: 'Could not download map data. Check your connection and retry.' };
  }
  await router.load([...coarseData].map(([key, data]) => ({ key, data })));

  let route: Route;
  const coarseResult = await router.route(origin, dest);
  if (!coarseResult.ok) {
    const reasons: Record<string, string> = {
      'no-origin': 'No roads found near your location in the downloaded data.',
      'no-destination': 'No roads found near the destination. Is it reachable by car?',
      'no-path': 'No drivable route found between these points.',
    };
    return { ok: false, error: reasons[coarseResult.reason] ?? 'Routing failed.' };
  }
  route = coarseResult.route;

  // ---- Phase 2: corridor + detail rebuild (skipped for short trips) -------
  if (coarseZ < 13) {
    const plan = planCorridor(route.points, route.steps, {
      corridorM: s.corridorM,
      detailRadiusM: s.detailRadiusM,
      routeCaching: s.routeCaching,
    });
    const keys = [...plan.corridor, ...plan.detail].map((t) => tileKey(t));
    onProgress?.({ phase: 'corridor', done: 0, total: keys.length });
    const corridorData = await tileProvider.obtainMany(keys, (done, total) =>
      onProgress?.({ phase: 'corridor', done, total }),
    );
    if (corridorData.size > 0) {
      await router.load([...corridorData].map(([key, data]) => ({ key, data })));
      const fine = await router.route(origin, dest);
      if (fine.ok) route = fine.route;
    }
  }

  // ---- Pin route tiles + prefetch tiny overview tiles in background -------
  const routeId = `route-${route.createdAt}`;
  const pinKeys = corridorKeysForRoute(route);
  cacheClient.pin(pinKeys, routeId);
  const overviewKeys = overviewTilesForRoute(route.points).map((t) => tileKey(t));
  void tileProvider.obtainMany(overviewKeys).then((m) => {
    if (m.size > 0) void router.load([...m].map(([key, data]) => ({ key, data })));
  });
  cacheClient.pin(overviewKeys, routeId);

  onProgress?.({ phase: 'done', done: 1, total: 1 });
  return { ok: true, route };
}

export function corridorKeysForRoute(route: Route): string[] {
  const s = settings.get();
  const plan = planCorridor(route.points, route.steps, {
    corridorM: s.corridorM,
    detailRadiusM: s.detailRadiusM,
    routeCaching: s.routeCaching,
  });
  const keys = new Set<string>();
  for (const t of [...plan.corridor, ...plan.detail]) keys.add(tileKey(t));
  return [...keys];
}

export function overviewTilesForRoute(points: LngLat[]): TileCoord[] {
  return planCorridor(points, [], {
    corridorM: 0,
    detailRadiusM: 0,
    routeCaching: false,
  }).overview;
}

/** Offline reroute: pure worker A* over the already-loaded corridor graph. */
export function rerouteLocal(origin: LngLat, dest: LngLat): Promise<RouteResult> {
  return router.route(origin, dest);
}
