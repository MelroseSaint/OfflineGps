/// <reference lib="webworker" />
import type { LngLat } from '../geo';
import { haversineM, pointSegmentDistM } from '../geo';

/** Min distance from p to a polyline (segment distance, bbox broad phase). */
function distanceToPathM(p: LngLat, path: LngLat[]): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (
      p[0] < Math.min(a[0], b[0]) - 0.3 ||
      p[0] > Math.max(a[0], b[0]) + 0.3 ||
      p[1] < Math.min(a[1], b[1]) - 0.3 ||
      p[1] > Math.max(a[1], b[1]) + 0.3
    ) {
      continue; // cheap bbox skip (0.3° ≈ 25–33 km)
    }
    const d = pointSegmentDistM(p, a, b);
    if (d < best) best = d;
  }
  return best;
}
import { parseTileKey, tileCenter } from '../tiles';
import { emptyGraph, addTileToGraph } from './tile-graph';
import type { RoutingGraph } from './graph';
import { findPath } from './astar';
import { assembleRoute } from './directions';
import { NodeIndex } from './snap';
import { stitchGraph, stitchMaxMForZoom } from './stitch';
import type { Route } from '../types';

export interface LoadTilesMsg {
  type: 'load';
  id: number;
  tiles: { key: string; data: ArrayBuffer }[];
}
export interface RouteMsg {
  type: 'route';
  id: number;
  origin: LngLat;
  dest: LngLat;
  snapMaxM?: number;
  mode?: 'car' | 'bicycle' | 'foot';
}
export interface PruneMsg {
  type: 'prune';
  id: number;
  center: LngLat;
  radiusM: number;
}
export interface DropCoarseMsg {
  type: 'drop-coarse';
  id: number;
  /** Drop every loaded tile at or below this zoom… */
  maxZoom: number;
  /** …except tiles whose center lies within keepRadiusM of this path. */
  keepNear?: LngLat[];
  keepRadiusM?: number;
}
export interface ResetMsg {
  type: 'reset';
  id: number;
}
export interface StatsMsg {
  type: 'stats';
  id: number;
  /** Optional point whose connected component size is reported. */
  near?: LngLat;
}
export type RouterRequest = LoadTilesMsg | RouteMsg | PruneMsg | DropCoarseMsg | ResetMsg | StatsMsg;

export type RouterReply =
  | { type: 'loaded'; id: number; tiles: number; edges: number; nodes: number }
  | { type: 'route'; id: number; ok: true; route: Route }
  | { type: 'route'; id: number; ok: false; reason: 'no-origin' | 'no-destination' | 'no-path' }
  | { type: 'pruned'; id: number; removed: number; edges: number }
  | { type: 'dropped'; id: number; removed: number; edges: number }
  | { type: 'reset'; id: number }
  | { type: 'stats'; id: number; liveEdges: number; nodes: number; component?: number };

// A 350 km corridor graph (z13 corridor + z14 detail) measures ~1.6M edges
// in practice; the cap only exists to bound worst-case memory (~300 MB).
const MAX_EDGES = 2_600_000;
// When the cap IS exceeded, keep this much around both ends of the route
// request — mid-route rerouting needs the vehicle area, not just the origin.
const AUTO_PRUNE_RADIUS_M = 60_000;

let graph: RoutingGraph = emptyGraph();
let nodeIndex: NodeIndex | null = null;
/** Tile key -> [startEdgeId, endEdgeId) appended by that tile. */
const tileEdgeRanges = new Map<string, [number, number]>();

function invalidateIndex(): void {
  nodeIndex = null;
}

function pruneAround(center: LngLat, radiusM: number, alsoKeep?: LngLat): number {
  let removed = 0;
  for (const [key, [start, end]] of tileEdgeRanges) {
    const t = parseTileKey(key);
    const c = tileCenter(t);
    // Keep tiles near the center AND (when given) near a second anchor —
    // long routes need both the vehicle area and the destination alive.
    if (haversineM(c, center) <= radiusM) continue;
    if (alsoKeep && haversineM(c, alsoKeep) <= radiusM) continue;
    for (let i = start; i < end; i++) {
      const e = graph.edges[i];
      if (!e.dead) {
        e.dead = true;
        removed++;
      }
    }
    tileEdgeRanges.delete(key);
  }
  // Drop orphan nodes from the index.
  if (nodeIndex) {
    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i];
      if (n.out.every((id) => graph.edges[id].dead) && n.in.every((id) => graph.edges[id].dead)) {
        nodeIndex.removeNode(i);
      }
    }
  }
  return removed;
}

self.onmessage = (ev: MessageEvent<RouterRequest>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    let loaded = 0;
    for (const t of msg.tiles) {
      if (tileEdgeRanges.has(t.key)) continue;
      const start = graph.edges.length;
      try {
        addTileToGraph(graph, parseTileKey(t.key), t.key, t.data);
      } catch {
        continue; // malformed tile — skip
      }
      tileEdgeRanges.set(t.key, [start, graph.edges.length]);
      loaded++;
    }
    if (loaded > 0) {
      // Use the coarsest loaded zoom to pick the stitch radius: low-zoom
      // tiles have large border gaps that need a wide snap window.
      let minZ = 99;
      for (const t of msg.tiles) {
        if (tileEdgeRanges.has(t.key)) {
          const z = parseTileKey(t.key).z;
          if (z < minZ) minZ = z;
        }
      }
      stitchGraph(graph, stitchMaxMForZoom(minZ));
    }
    invalidateIndex();
    const reply: RouterReply = {
      type: 'loaded',
      id: msg.id,
      tiles: loaded,
      edges: graph.edges.length,
      nodes: graph.nodes.length,
    };
    (self as unknown as Worker).postMessage(reply);
  } else if (msg.type === 'route') {
    const idx = (nodeIndex ??= new NodeIndex(graph));
    const snapMax = msg.snapMaxM ?? 5000;
    const o = idx.nearest(msg.origin, snapMax);
    const d = idx.nearest(msg.dest, snapMax);
    if (!o) {
      (self as unknown as Worker).postMessage({
        type: 'route',
        id: msg.id,
        ok: false,
        reason: 'no-origin',
      } satisfies RouterReply);
      return;
    }
    if (!d) {
      (self as unknown as Worker).postMessage({
        type: 'route',
        id: msg.id,
        ok: false,
        reason: 'no-destination',
      } satisfies RouterReply);
      return;
    }
    // Auto-prune under memory pressure, keeping both ends of this request.
    if (graph.edges.length > MAX_EDGES) pruneAround(msg.origin, AUTO_PRUNE_RADIUS_M, msg.dest);
    const path = findPath(graph, o.node, d.node, undefined, msg.mode);
    if (!path) {
      (self as unknown as Worker).postMessage({
        type: 'route',
        id: msg.id,
        ok: false,
        reason: 'no-path',
      } satisfies RouterReply);
      return;
    }
    const route = assembleRoute(graph, path);
    (self as unknown as Worker).postMessage({
      type: 'route',
      id: msg.id,
      ok: true,
      route,
    } satisfies RouterReply);
  } else if (msg.type === 'prune') {
    const removed = pruneAround(msg.center, msg.radiusM);
    (self as unknown as Worker).postMessage({
      type: 'pruned',
      id: msg.id,
      removed,
      edges: graph.edges.length,
    } satisfies RouterReply);
  } else if (msg.type === 'drop-coarse') {
    // The coarse (low-zoom) graph exists only to find the initial route;
    // once the fine corridor is loaded most of it is dead weight. Drop it —
    // but keep coarse tiles near the route: their simplified long edges
    // often bridge connectivity gaps that the detailed graph cannot.
    let removed = 0;
    for (const [key, [start, end]] of tileEdgeRanges) {
      if (parseTileKey(key).z > msg.maxZoom) continue;
      if (msg.keepNear && msg.keepNear.length >= 2) {
        const c = tileCenter(parseTileKey(key));
        if (distanceToPathM(c, msg.keepNear) <= (msg.keepRadiusM ?? 10_000)) continue;
      }
      for (let i = start; i < end; i++) {
        const e = graph.edges[i];
        if (!e.dead) {
          e.dead = true;
          removed++;
        }
      }
      tileEdgeRanges.delete(key);
    }
    invalidateIndex();
    (self as unknown as Worker).postMessage({
      type: 'dropped',
      id: msg.id,
      removed,
      edges: graph.edges.length,
    } satisfies RouterReply);
  } else if (msg.type === 'reset') {
    graph = emptyGraph();
    tileEdgeRanges.clear();
    invalidateIndex();
    (self as unknown as Worker).postMessage({ type: 'reset', id: msg.id } satisfies RouterReply);
  } else if (msg.type === 'stats') {
    let liveEdges = 0;
    for (const e of graph.edges) if (!e.dead) liveEdges++;
    let component: number | undefined;
    if (msg.near && nodeIndex) {
      const o = nodeIndex.nearest(msg.near, 5000);
      if (o) {
        const seen = new Set<number>([o.node]);
        const q = [o.node];
        while (q.length) {
          const n = q.pop()!;
          for (const eid of graph.nodes[n].out) {
            const e = graph.edges[eid];
            if (!e.dead && !seen.has(e.to)) {
              seen.add(e.to);
              q.push(e.to);
            }
          }
          for (const eid of graph.nodes[n].in) {
            const e = graph.edges[eid];
            if (!e.dead && !seen.has(e.from)) {
              seen.add(e.from);
              q.push(e.from);
            }
          }
        }
        component = seen.size;
      }
    }
    (self as unknown as Worker).postMessage({
      type: 'stats',
      id: msg.id,
      liveEdges,
      nodes: graph.nodes.length,
      component,
    } satisfies RouterReply);
  }
};
