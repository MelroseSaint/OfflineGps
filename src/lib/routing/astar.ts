import { haversineM } from '../geo';
import type { RoutingGraph } from './graph';

export interface RoutePath {
  /** Node indices from start to goal. */
  nodes: number[];
  /** Edge id used between nodes[i] and nodes[i+1]. */
  edges: number[];
  distM: number;
  /** Travel-time weight in seconds. */
  weightS: number;
}

/** Binary min-heap keyed by f-score. */
class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.items.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

const MAX_SPEED_KMH = 110; // must be >= any CLASS_SPEED_KMH value

/**
 * A* over the routing graph. Heuristic: straight-line distance at max speed,
 * which is admissible, so results are optimal for our cost model.
 */
export function findPath(
  g: RoutingGraph,
  start: number,
  goal: number,
  maxPops = 9_000_000,
): RoutePath | null {
  const n = g.nodes.length;
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFromEdge = new Int32Array(n).fill(-1);
  const cameFromNode = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const hCache = new Float64Array(n).fill(-1);

  const h = (node: number): number => {
    let v = hCache[node];
    if (v < 0) {
      v = (haversineM(g.nodes[node].coord, g.nodes[goal].coord) / (MAX_SPEED_KMH / 3.6));
      hCache[node] = v;
    }
    return v;
  };

  const heap = new MinHeap();
  gScore[start] = 0;
  heap.push(start, h(start));
  let pops = 0;

  while (heap.size > 0) {
    const cur = heap.pop()!;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) break;
    if (++pops > maxPops) return null;
    const node = g.nodes[cur];
    for (const eid of node.out) {
      const e = g.edges[eid];
      if (e.dead) continue; // pruned
      if (e.from !== cur) continue; // stale adjacency after pruning
      const nb = e.to;
      if (closed[nb]) continue;
      const tentative = gScore[cur] + e.weight;
      if (tentative < gScore[nb]) {
        gScore[nb] = tentative;
        cameFromEdge[nb] = eid;
        cameFromNode[nb] = cur;
        heap.push(nb, tentative + h(nb));
      }
    }
  }

  if (!closed[goal]) return null;

  const nodes: number[] = [];
  const edges: number[] = [];
  let cur = goal;
  let distM = 0;
  while (cur !== start) {
    nodes.push(cur);
    const eid = cameFromEdge[cur];
    if (eid < 0) return null;
    const e = g.edges[eid];
    edges.push(eid);
    distM += e.lengthM;
    cur = cameFromNode[cur];
    if (nodes.length > n) return null; // cycle guard
  }
  nodes.push(start);
  nodes.reverse();
  edges.reverse();
  return { nodes, edges, distM, weightS: gScore[goal] };
}
