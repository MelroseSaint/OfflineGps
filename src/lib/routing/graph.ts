import type { LngLat } from '../geo';

/** Speed limit defaults by OSM highway class (km/h). */
export const CLASS_SPEED_KMH: Record<string, number> = {
  motorway: 110,
  motorway_link: 60,
  trunk: 90,
  trunk_link: 50,
  primary: 65,
  primary_link: 45,
  secondary: 55,
  secondary_link: 40,
  tertiary: 45,
  tertiary_link: 35,
  /** planetiler's OpenMapTiles profile reports small streets as `minor` at z12–13. */
  minor: 40,
  unclassified: 45,
  residential: 30,
  living_street: 15,
  service: 20,
  track: 25,
  pedestrian: 5,
  footway: 5,
  path: 5,
  cycleway: 15,
  steps: 3,
};

/** Whether a class is drivable (excludes paths, steps, piers, raceways). */
export function isDrivable(cls: string): boolean {
  return cls in CLASS_SPEED_KMH && !['pedestrian', 'footway', 'path', 'steps', 'pier', 'raceway'].includes(cls);
}

export type Oneway = 0 | 1 | -1;

export interface GraphNode {
  id: number;
  /** [lng, lat] */
  coord: LngLat;
  /** Outgoing edge ids. */
  out: number[];
  /** Incoming edge ids. */
  in: number[];
}

export interface GraphEdge {
  id: number;
  from: number;
  to: number;
  /** Interior geometry between the endpoints (tile-local derived, lng/lat). */
  shape: LngLat[];
  lengthM: number;
  /** seconds */
  weight: number;
  cls: string;
  subclass?: string;
  oneway: Oneway;
  /** Layer level for bridges/tunnels (-5..9). */
  layer: number;
  name?: string;
  ramp?: 0 | 1;
  roundabout?: boolean;
  /** Indexed Bendy vertex id of the `from` node (for snapping). */
  vertexId?: number;
  /** Set when the edge has been pruned from memory. */
  dead?: boolean;
}

export interface RoutingGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Exact vertex id -> node index (fast path). */
  vertexToNode: Map<number, number>;
  /** Spatial cell grid for proximity node merging across tile borders. */
  nodeGrid: Map<number, number[]>;
  nodeCount: number;
}

export function makeGraph(): RoutingGraph {
  return { nodes: [], edges: [], vertexToNode: new Map(), nodeGrid: new Map(), nodeCount: 0 };
}

const Q = 1 / 32768; // node quantum, degrees (~3.4 m)
const CELL_Q = 2; // grid cell = 2 quanta
const MERGE_M = 2.5; // merge nodes closer than this

function cellKey(cx: number, cy: number): number {
  return (cx + 2 ** 22) * 2 ** 23 + (cy + 2 ** 22);
}

/**
 * Find or create a node at coord. Exact vertex matches use the fast map;
 * otherwise the 3×3 cell neighborhood is searched and any node within
 * MERGE_M meters is reused. This stitches tile-border vertices (which differ
 * by sub-meter rounding between tiles) and cross-zoom geometry together.
 */
export function findOrCreateNode(g: RoutingGraph, coord: LngLat): number {
  const xl = Math.round(coord[0] / Q);
  const yl = Math.round(coord[1] / Q);
  const exactId = xl * 2 ** 23 + (yl + 2 ** 22);
  const exact = g.vertexToNode.get(exactId);
  if (exact !== undefined) return exact;

  const cx = Math.floor(xl / CELL_Q);
  const cy = Math.floor(yl / CELL_Q);
  const cosLat = Math.cos((coord[1] * Math.PI) / 180);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = g.nodeGrid.get(cellKey(cx + dx, cy + dy));
      if (!arr) continue;
      for (const ni of arr) {
        const [nlng, nlat] = g.nodes[ni].coord;
        const nxl = Math.round(nlng / Q);
        const nyl = Math.round(nlat / Q);
        const dxm = ((xl - nxl) * Q) * 111_320 * cosLat;
        const dym = ((yl - nyl) * Q) * 111_320;
        if (Math.hypot(dxm, dym) <= MERGE_M) {
          g.vertexToNode.set(exactId, ni);
          return ni;
        }
      }
    }
  }

  const idx = g.nodes.length;
  g.nodes.push({ id: idx, coord, out: [], in: [] });
  g.nodeCount++;
  g.vertexToNode.set(exactId, idx);
  const key = cellKey(cx, cy);
  let arr = g.nodeGrid.get(key);
  if (!arr) {
    arr = [];
    g.nodeGrid.set(key, arr);
  }
  arr.push(idx);
  return idx;
}

/** Returns [edge, reverseEdge] — reverse is null unless the way is bidirectional. */
export function addEdge(
  g: RoutingGraph,
  from: number,
  to: number,
  shape: LngLat[],
  opts: {
    cls: string;
    subclass?: string;
    oneway: Oneway;
    layer: number;
    name?: string;
    ramp?: 0 | 1;
    roundabout?: boolean;
  },
): [GraphEdge, GraphEdge | null] {
  const path = [g.nodes[from].coord, ...shape, g.nodes[to].coord];
  let lengthM = 0;
  for (let i = 0; i < path.length - 1; i++) {
    lengthM += haversine(path[i], path[i + 1]);
  }
  const kmh = CLASS_SPEED_KMH[opts.cls] ?? 30;
  // Small penalty for links/ramps and roundabouts (conservative travel time).
  let weight = (lengthM / 1000 / kmh) * 3600;
  if (opts.ramp) weight *= 1.1;
  if (opts.roundabout) weight *= 1.2;

  const e: GraphEdge = {
    id: g.edges.length,
    from,
    to,
    shape,
    lengthM,
    weight,
    cls: opts.cls,
    subclass: opts.subclass,
    oneway: opts.oneway,
    layer: opts.layer,
    name: opts.name,
    ramp: opts.ramp,
    roundabout: opts.roundabout,
  };
  g.edges.push(e);
  g.nodes[from].out.push(e.id);
  g.nodes[to].in.push(e.id);

  let rev: GraphEdge | null = null;
  if (opts.oneway === 0) {
    // Two-way: add the reverse edge.
    rev = {
      ...e,
      id: g.edges.length,
      from: to,
      to: from,
    };
    g.edges.push(rev);
    g.nodes[to].out.push(rev.id);
    g.nodes[from].in.push(rev.id);
  } else if (opts.oneway === -1) {
    // Reverse oneway: the forward edge we just pushed must not exist.
    e.dead = true;
    g.nodes[from].out = g.nodes[from].out.filter((id) => id !== e.id);
    g.nodes[to].in = g.nodes[to].in.filter((id) => id !== e.id);
    rev = {
      ...e,
      id: g.edges.length,
      from: to,
      to: from,
      dead: false,
    };
    g.edges.push(rev);
    g.nodes[to].out.push(rev.id);
    g.nodes[from].in.push(rev.id);
  }
  return [e, rev];
}

function haversine(a: LngLat, b: LngLat): number {
  const R = 6371008.8;
  const dLat = (b[1] - a[1]) * (Math.PI / 180);
  const dLng = (b[0] - a[0]) * (Math.PI / 180);
  const φ1 = a[1] * (Math.PI / 180);
  const φ2 = b[1] * (Math.PI / 180);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
