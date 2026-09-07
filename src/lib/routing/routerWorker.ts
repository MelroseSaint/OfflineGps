/// <reference lib="webworker" />
import type { LngLat } from '../geo';
import { haversineM } from '../geo';
import { parseTileKey, tileCenter } from '../tiles';
import { emptyGraph, addTileToGraph } from './tile-graph';
import type { RoutingGraph } from './graph';
import { findPath } from './astar';
import { assembleRoute } from './directions';
import { NodeIndex } from './snap';
import { stitchGraph } from './stitch';
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
}
export interface PruneMsg {
  type: 'prune';
  id: number;
  center: LngLat;
  radiusM: number;
}
export interface ResetMsg {
  type: 'reset';
  id: number;
}
export type RouterRequest = LoadTilesMsg | RouteMsg | PruneMsg | ResetMsg;

export type RouterReply =
  | { type: 'loaded'; id: number; tiles: number; edges: number; nodes: number }
  | { type: 'route'; id: number; ok: true; route: Route }
  | { type: 'route'; id: number; ok: false; reason: 'no-origin' | 'no-destination' | 'no-path' }
  | { type: 'pruned'; id: number; removed: number; edges: number }
  | { type: 'reset'; id: number };

const MAX_EDGES = 1_100_000;
const AUTO_PRUNE_RADIUS_M = 20_000;

let graph: RoutingGraph = emptyGraph();
let nodeIndex: NodeIndex | null = null;
/** Tile key -> [startEdgeId, endEdgeId) appended by that tile. */
const tileEdgeRanges = new Map<string, [number, number]>();

function invalidateIndex(): void {
  nodeIndex = null;
}

function pruneAround(center: LngLat, radiusM: number): number {
  let removed = 0;
  for (const [key, [start, end]] of tileEdgeRanges) {
    const t = parseTileKey(key);
    const c = tileCenter(t);
    if (haversineM(c, center) <= radiusM) continue;
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
    if (loaded > 0) stitchGraph(graph);
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
    const snapMax = msg.snapMaxM ?? 3000;
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
    // Auto-prune under memory pressure, keeping the area near the origin.
    if (graph.edges.length > MAX_EDGES) pruneAround(msg.origin, AUTO_PRUNE_RADIUS_M);
    const path = findPath(graph, o.node, d.node);
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
  } else if (msg.type === 'reset') {
    graph = emptyGraph();
    tileEdgeRanges.clear();
    invalidateIndex();
    (self as unknown as Worker).postMessage({ type: 'reset', id: msg.id } satisfies RouterReply);
  }
};
