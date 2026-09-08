import { pointSegmentDistM, bearingDeg, angleDiff, type LngLat } from '../geo';
import type { RoutingGraph } from './graph';
import { findOrCreateNode } from './graph';

const STITCH_MIN_M = 0.5;
const CELL_DEG = 0.002; // ~200 m at mid latitudes

/**
 * Max snap distance for stitching tile-border discontinuities.
 * Planetiler clips ways at the tile edge *plus a buffer*, and at low zooms
 * geometry simplification makes the two adjacent copies diverge, so the gap
 * scales with tile size. Measured empirically: z13+ ≈ 30 m, z12 ≈ 120 m,
 * z11 ≈ 350 m, z10 ≈ 700 m.
 */
export function stitchMaxMForZoom(z: number): number {
  if (z >= 13) return 30;
  if (z === 12) return 120;
  if (z === 11) return 350;
  if (z === 10) return 700;
  return 1200;
}

interface SegRef {
  eid: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function edgePathCoords(g: RoutingGraph, eid: number): LngLat[] {
  const e = g.edges[eid];
  return [g.nodes[e.from].coord, ...e.shape, g.nodes[e.to].coord];
}

/**
 * Reconnect the graph after tile loading.
 *
 * Vector tiles clip ways at the tile boundary *plus a buffer*, so the two
 * adjacent tiles' copies of the same road overlap without sharing vertices.
 * Their cut points sit a few meters to ~20 m apart, which would fragment the
 * graph into per-tile-row components. Fix: every dead-end node (degree 1)
 * is projected onto nearby edges; if the projection is a good continuation
 * (close + roughly aligned), the target edge is split at the projection and
 * the dead end is connected to it.
 */
export function stitchGraph(g: RoutingGraph, maxStitchM = 30): number {
  // 1. Index all live segments.
  const grid = new Map<number, SegRef[]>();
  const cellOf = (lng: number, lat: number): number => {
    const cx = Math.floor(lng / CELL_DEG);
    const cy = Math.floor(lat / CELL_DEG);
    return (cx + 4096) * 16384 + (cy + 4096);
  };
  const indexSeg = (eid: number, a: LngLat, b: LngLat): void => {
    const ref: SegRef = { eid, ax: a[0], ay: a[1], bx: b[0], by: b[1] };
    const k = cellOf((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    let arr = grid.get(k);
    if (!arr) {
      arr = [];
      grid.set(k, arr);
    }
    arr.push(ref);
  };
  for (const e of g.edges) {
    if (e.dead) continue;
    const path = edgePathCoords(g, e.id);
    for (let i = 0; i < path.length - 1; i++) indexSeg(e.id, path[i], path[i + 1]);
  }

  // 2. Dead-end nodes. Edges come in forward/reverse pairs, so a dead end
  // (one incident road segment) has exactly 1 out + 1 in — directed degree 2.
  // A pass-through vertex always has ≥2 segments (≥2 out + ≥2 in).
  const deadEnds: number[] = [];
  for (const n of g.nodes) {
    if (n.out.length === 1 && n.in.length === 1 && n.out[0] !== n.in[0]) {
      deadEnds.push(n.id);
    }
  }

  // 3. Snap each dead end onto the best nearby segment.
  let stitches = 0;
  const R = 6371008.8;
  for (const nodeId of deadEnds) {
    const node = g.nodes[nodeId];
    if (node.out.length !== 1 || node.in.length !== 1 || node.out[0] === node.in[0]) continue; // may have changed
    const incident = new Set([...node.out, ...node.in]);
    const selfCls = g.edges[node.out[0] ?? node.in[0]].cls;

    let best: {
      eid: number;
      segIdx: number;
      t: number;
      distM: number;
      point: LngLat;
    } | null = null;

    const cx = Math.floor(node.coord[0] / CELL_DEG);
    const cy = Math.floor(node.coord[1] / CELL_DEG);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(cellKeyOf(cx + dx, cy + dy));
        if (!arr) continue;
        for (const ref of arr) {
          if (incident.has(ref.eid)) continue;
          const e = g.edges[ref.eid];
          if (e.dead) continue;
          const a: LngLat = [ref.ax, ref.ay];
          const b: LngLat = [ref.bx, ref.by];
          const dist = pointSegmentDistM(node.coord, a, b);
          if (dist < STITCH_MIN_M || dist > maxStitchM) continue;
          if (best && dist >= best.distM) continue;
          // Projection parameter t along the segment.
          const px = node.coord[0] * 111_320 * Math.cos((node.coord[1] * Math.PI) / 180);
          const py = node.coord[1] * 111_320;
          const ax = a[0] * 111_320 * Math.cos((node.coord[1] * Math.PI) / 180);
          const ay = a[1] * 111_320;
          const bx = b[0] * 111_320 * Math.cos((node.coord[1] * Math.PI) / 180);
          const by = b[1] * 111_320;
          const dx2 = bx - ax;
          const dy2 = by - ay;
          const l2 = dx2 * dx2 + dy2 * dy2;
          let t = l2 === 0 ? 0 : ((px - ax) * dx2 + (py - ay) * dy2) / l2;
          t = Math.max(0.02, Math.min(0.98, t)); // keep away from segment ends
          // Alignment: direction of travel at the dead end vs target segment
          // heading. (For out-edges ownPath[0] is the node; for in-edges the
          // node is ownPath[last].)
          const ownPath = edgePathCoords(g, [...node.out, ...node.in][0]);
          const ownBearing =
            node.out.length > 0
              ? bearingDeg(ownPath[0], ownPath[1] ?? ownPath[0])
              : bearingDeg(ownPath[ownPath.length - 2] ?? ownPath[0], ownPath[ownPath.length - 1]);
          const targetBearing = bearingDeg(a, b);
          const align = Math.abs(angleDiff(ownBearing, targetBearing));
          if (align > 75 && align < 105) {
            // perpendicular approach (e.g. driveway) — allow
          } else if (align > (maxStitchM > 60 ? 150 : 105)) {
            continue; // pointing away — not a continuation
          }
          best = {
            eid: ref.eid,
            segIdx: 0,
            t,
            distM: dist,
            point: [
              ref.ax + t * (ref.bx - ref.ax),
              ref.ay + t * (ref.by - ref.ay),
            ],
          };
          // remember which segment within the edge
          best.segIdx = segIndexOf(g, ref.eid, ref);
        }
      }
    }
    if (!best) continue;
    if (splitEdgeAt(g, best.eid, best.segIdx, best.t, nodeId, selfCls)) stitches++;
  }
  return stitches;

  function cellKeyOf(cx: number, cy: number): number {
    return (cx + 4096) * 16384 + (cy + 4096);
  }

  function segIndexOf(gg: RoutingGraph, eid: number, ref: SegRef): number {
    // Match the indexed segment back to its index in the edge path.
    const path = edgePathCoords(gg, eid);
    for (let i = 0; i < path.length - 1; i++) {
      if (path[i][0] === ref.ax && path[i][1] === ref.ay && path[i + 1][0] === ref.bx && path[i + 1][1] === ref.by) {
        return i;
      }
    }
    return 0;
  }
}

/** Split edge eid at (segIdx, t), attach nodeId to the new junction node. */
function splitEdgeAt(
  g: RoutingGraph,
  eid: number,
  segIdx: number,
  t: number,
  attachNodeId: number,
  cls: string,
): boolean {
  const e = g.edges[eid];
  if (e.dead) return false;
  const path = edgePathCoords(g, eid);
  const a = path[segIdx];
  const b = path[segIdx + 1];
  const P: LngLat = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];

  const junction = findOrCreateNode(g, P);
  if (junction === e.from || junction === e.to || junction === attachNodeId) return false;

  const haversine = (p: LngLat, q: LngLat): number => {
    const dLat = (q[1] - p[1]) * (Math.PI / 180);
    const dLng = (q[0] - p[0]) * (Math.PI / 180) * Math.cos((p[1] * Math.PI) / 180);
    return Math.hypot(dLat, dLng * 1) * R_M;
  };
  const R_M = 111_320;

  const len1 = segLen(path, 0, segIdx) + haversine(a, P);
  const len2 = haversine(P, b) + segLen(path, segIdx + 1, path.length - 1);
  const frac1 = len1 / Math.max(1e-6, e.lengthM);
  const frac2 = 1 - frac1;

  const detach = (nodeIdx: number, id: number, list: 'out' | 'in'): void => {
    const arr = g.nodes[nodeIdx][list];
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
  };

  // Kill original edge (and its reverse twin if any) and rebuild pieces.
  e.dead = true;
  detach(e.from, e.id, 'out');
  detach(e.to, e.id, 'in');

  const makeEdge = (from: number, to: number, shape: LngLat[], lenM: number, weight: number, dead: boolean): GraphEdgeLite => {
    const ne = {
      id: g.edges.length,
      from,
      to,
      shape,
      lengthM: lenM,
      weight,
      cls: e.cls,
      subclass: e.subclass,
      oneway: e.oneway,
      layer: e.layer,
      name: e.name,
      ramp: e.ramp,
      roundabout: e.roundabout,
      dead,
    };
    g.edges.push(ne);
    if (!dead) {
      g.nodes[from].out.push(ne.id);
      g.nodes[to].in.push(ne.id);
    }
    return ne;
  };

  // Forward pieces (respect original oneway: forward exists unless oneway===-1)
  const fwd = e.oneway !== -1;
  const rev = e.oneway === 0;
  if (fwd) {
    makeEdge(e.from, junction, path.slice(1, segIdx + 1), len1, e.weight * frac1, false);
    makeEdge(junction, e.to, [P, ...path.slice(segIdx + 1, path.length - 1)], len2, e.weight * frac2, false);
  }
  if (rev) {
    makeEdge(junction, e.from, [...path.slice(1, segIdx + 1)].reverse(), len1, e.weight * frac1, false);
    makeEdge(e.to, junction, [...[P, ...path.slice(segIdx + 1, path.length - 1)]].reverse(), len2, e.weight * frac2, false);
  }

  // Connector from the dead end to the junction (bidirectional).
  const attachDist = haversine(g.nodes[attachNodeId].coord, g.nodes[junction].coord);
  if (attachNodeId !== junction && attachDist > 0.5) {
    const c = {
      id: g.edges.length,
      from: attachNodeId,
      to: junction,
      shape: [] as LngLat[],
      lengthM: attachDist,
      weight: (attachDist / 1000 / 30) * 3600, // conservative connector speed
      cls,
      oneway: 0 as const,
      layer: e.layer,
      name: e.name,
      dead: false,
    };
    g.edges.push(c);
    g.nodes[attachNodeId].out.push(c.id);
    g.nodes[junction].in.push(c.id);
    const cr = { ...c, id: g.edges.length, from: junction, to: attachNodeId };
    g.edges.push(cr);
    g.nodes[junction].out.push(cr.id);
    g.nodes[attachNodeId].in.push(cr.id);
  }
  return true;

  function segLen(path2: LngLat[], from: number, to: number): number {
    let d = 0;
    for (let i = from; i < to; i++) d += haversine(path2[i], path2[i + 1]);
    return d;
  }
}

interface GraphEdgeLite {
  id: number;
  from: number;
  to: number;
  shape: LngLat[];
  lengthM: number;
  weight: number;
  cls: string;
  subclass?: string;
  oneway: 0 | 1 | -1;
  layer: number;
  name?: string;
  ramp?: 0 | 1;
  roundabout?: boolean;
  dead: boolean;
}
