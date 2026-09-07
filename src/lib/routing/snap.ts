import { haversineM, type LngLat } from '../geo';
import type { RoutingGraph } from './graph';

const CELL = 0.01; // degrees, ~1.1 km

/** Higher is better — snapping prefers the most significant road nearby. */
const CLASS_RANK: Record<string, number> = {
  motorway: 10,
  trunk: 9,
  primary: 8,
  secondary: 7,
  tertiary: 6,
  residential: 5,
  unclassified: 5,
  minor: 5,
  living_street: 3,
  service: 1,
  track: 1,
};

/** Lazy uniform-grid index over graph nodes for nearest-node queries. */
export class NodeIndex {
  private cells = new Map<number, number[]>();
  private built = false;

  constructor(private g: RoutingGraph) {}

  private key(cx: number, cy: number): number {
    return (cx + 4096) * 16384 + (cy + 4096);
  }

  build(): void {
    if (this.built) return;
    for (let i = 0; i < this.g.nodes.length; i++) {
      const [lng, lat] = this.g.nodes[i].coord;
      const k = this.key(Math.floor(lng / CELL), Math.floor(lat / CELL));
      let arr = this.cells.get(k);
      if (!arr) {
        arr = [];
        this.cells.set(k, arr);
      }
      arr.push(i);
    }
    this.built = true;
  }

  /**
   * Nearest node within maxM. Rings expand outward from the query cell, so a
   * miss is authoritative once rings exceed the search radius.
   */
  nearest(p: LngLat, maxM: number): { node: number; distM: number } | null {
    this.build();
    const cx = Math.floor(p[0] / CELL);
    const cy = Math.floor(p[1] / CELL);
    const maxRing = Math.ceil(maxM / (CELL * 111_000)) + 1;
    const candidates: { node: number; distM: number; rank: number }[] = [];
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const arr = this.cells.get(this.key(cx + dx, cy + dy));
          if (!arr) continue;
          for (const ni of arr) {
            const d = haversineM(p, this.g.nodes[ni].coord);
            candidates.push({ node: ni, distM: d, rank: this.nodeRank(ni) });
          }
        }
      }
      if (candidates.length > 0 && ring >= 1) break; // near matches found
    }
    if (candidates.length === 0) return null;
    // Prefer significant roads within a small radius; fall back to nearest.
    const near = candidates.filter((c) => c.distM <= 150);
    if (near.length > 0) {
      near.sort((a, b) => b.rank - a.rank || a.distM - b.distM);
      return { node: near[0].node, distM: near[0].distM };
    }
    candidates.sort((a, b) => a.distM - b.distM);
    return candidates[0].distM <= maxM ? { node: candidates[0].node, distM: candidates[0].distM } : null;
  }

  private nodeRank(nodeIdx: number): number {
    const n = this.g.nodes[nodeIdx];
    let rank = 0;
    for (const eid of n.out) {
      const e = this.g.edges[eid];
      if (e.dead) continue;
      rank = Math.max(rank, CLASS_RANK[e.cls] ?? 0);
    }
    return rank;
  }

  /** Drop orphan nodes (no edges) after pruning. */
  removeNode(idx: number): void {
    const [lng, lat] = this.g.nodes[idx].coord;
    const k = this.key(Math.floor(lng / CELL), Math.floor(lat / CELL));
    const arr = this.cells.get(k);
    if (arr) {
      const i = arr.indexOf(idx);
      if (i >= 0) arr.splice(i, 1);
    }
  }
}
