import { readMvt } from '../mvt/decode';
import type { LngLat } from '../geo';
import { addEdge, findOrCreateNode, makeGraph, isAccessible, type GraphEdge, type RoutingGraph } from './graph';
import type { TileCoord } from '../tiles';
import { tileToLngLatBounds } from '../tiles';

const TRANSPORTATION_LAYERS = ['transportation', 'road'];

/**
 * Node coordinates snap to a 1/32768-degree grid (~3.4 m) derived from
 * absolute lng/lat, so geometry from adjacent tiles at any zoom stitches into
 * a connected graph. Crucially, a node is created at EVERY road vertex —
 * planetiler merges ways for rendering, so junctions often sit at interior
 * vertices of a merged linestring, not at its endpoints. Shared vertices
 * across ways then collapse into one node, restoring topology.
 */
const SNAP_N = 32768;

function snapCoord(lng: number, lat: number): LngLat {
  return [Math.round(lng * SNAP_N) / SNAP_N, Math.round(lat * SNAP_N) / SNAP_N];
}

function vertexIdOf([lng, lat]: LngLat): number {
  const xl = Math.round(lng * SNAP_N); // |xl| < 2^23
  const yl = Math.round(lat * SNAP_N); // |yl| < 2^22
  // Collision-free packing into one double-safe integer (< 2^46).
  return (xl + 2 ** 23) * 2 ** 23 + (yl + 2 ** 22);
}

function parseOneway(v: unknown): 0 | 1 | -1 {
  if (v === 1 || v === true || v === '1' || v === 'true' || v === 'yes') return 1;
  if (v === -1 || v === '-1') return -1;
  return 0;
}

export interface TileRoads {
  key: string;
  nameCount: number;
}

/**
 * Extract the drivable road network from a vector tile and merge it into the
 * graph. Roads carry class/oneway/ramp properties; display names live in a
 * parallel layer (OpenMapTiles schema) or inline (Shortbread schema).
 */
export function addTileToGraph(
  g: RoutingGraph,
  tile: TileCoord,
  key: string,
  data: ArrayBuffer,
): TileRoads {
  const layers = readMvt(data);
  const roadLayer = layers.find((l) => TRANSPORTATION_LAYERS.includes(l.name));
  if (!roadLayer) return { key, nameCount: 0 };

  const extent = roadLayer.extent;
  const { sw, ne } = tileToLngLatBounds(tile);
  const toLngLat = (x: number, y: number): LngLat => [
    sw[0] + (x / extent) * (ne[0] - sw[0]),
    sw[1] + (y / extent) * (ne[1] - sw[1]),
  ];

  let nameCount = 0;
  const createdEdges: [GraphEdge, GraphEdge | null][] = [];

  for (const feat of roadLayer.features) {
    if (feat.type !== 2 || feat.paths.length < 2) continue;
    const props = feat.props;
    let cls = String(props.class ?? props.kind ?? '');
    if (cls === 'minor') cls = 'residential';
    // Include ALL road types — filter by transport mode at A* time.
    if (!cls) continue;

    const oneway = parseOneway(props.oneway);
    const ramp = props.ramp === 1 || props.ramp === true ? (1 as const) : undefined;
    const name = typeof props.name === 'string' && props.name ? props.name : undefined;
    if (name) nameCount++;
    const layerLevel = typeof props.layer === 'number' ? props.layer : 0;

    // Snap every vertex; collapse near-duplicates so consecutive snapped
    // points are always distinct (no zero-length edges). Nodes are merged
    // by proximity (findOrCreateNode) so shared junction vertices and
    // tile-border copies collapse into single nodes.
    const snapped: LngLat[] = [];
    for (const [x, y] of feat.paths) {
      const c = snapCoord(...toLngLat(x, y));
      if (snapped.length > 0) {
        const p = snapped[snapped.length - 1];
        if (p[0] === c[0] && p[1] === c[1]) continue;
      }
      snapped.push(c);
    }
    if (snapped.length < 2) continue;

    for (let i = 0; i < snapped.length - 1; i++) {
      const from = findOrCreateNode(g, snapped[i]);
      const to = findOrCreateNode(g, snapped[i + 1]);
      if (from === to) continue;
      createdEdges.push(
        addEdge(g, from, to, [], {
          cls,
          subclass: typeof props.subclass === 'string' ? props.subclass : undefined,
          oneway,
          layer: layerLevel,
          name,
          ramp,
        }) as [GraphEdge, GraphEdge | null],
      );
    }
  }

  // ---- Name join ----------------------------------------------------------
  // OpenMapTiles keeps street names in a parallel transportation_name layer
  // (planetiler merges road geometry but not names). Name lines share exact
  // snapped vertices with road geometry, so we hash name vertices and attach
  // names to unnamed edges via their endpoint nodes (or a nearby vertex).
  const nameLayer = layers.find((l) => l.name === 'transportation_name');
  if (nameLayer) {
    const nameByVertex = new Map<number, string>();
    const nameCells = new Map<number, { lng: number; lat: number; name: string }[]>();
    for (const f of nameLayer.features) {
      const nm = f.props.name;
      if (typeof nm !== 'string' || !nm) continue;
      for (const [x, y] of f.paths) {
        const c = snapCoord(...toLngLat(x, y));
        const vid = vertexIdOf(c);
        if (!nameByVertex.has(vid)) nameByVertex.set(vid, nm);
        const ck = nameCellOf(c);
        let arr = nameCells.get(ck);
        if (!arr) {
          arr = [];
          nameCells.set(ck, arr);
        }
        arr.push({ lng: c[0], lat: c[1], name: nm });
      }
    }
    const nearestName = (c: LngLat): string | undefined => {
      const vid = vertexIdOf(c);
      const exact = nameByVertex.get(vid);
      if (exact) return exact;
      const cx = Math.floor(c[0] / 0.001);
      const cy = Math.floor(c[1] / 0.001);
      let best: string | undefined;
      let bestD = 15; // meters
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = nameCells.get((cx + dx + 4096) * 16384 + (cy + dy + 4096));
          if (!arr) continue;
          for (const p of arr) {
            const dLat = (p.lat - c[1]) * 111_320;
            const dLng = (p.lng - c[0]) * 111_320 * Math.cos((c[1] * Math.PI) / 180);
            const d = Math.hypot(dLat, dLng);
            if (d < bestD) {
              bestD = d;
              best = p.name;
            }
          }
        }
      }
      return best;
    };
    for (const [e, rev] of createdEdges) {
      const edgesToName = [e, ...(rev ? [rev] : [])];
      if (e.name) continue;
      const fromCoord = g.nodes[e.from].coord;
      const toCoord = g.nodes[e.to].coord;
      const mid: LngLat = [(fromCoord[0] + toCoord[0]) / 2, (fromCoord[1] + toCoord[1]) / 2];
      const nm = nearestName(fromCoord) ?? nearestName(mid) ?? nearestName(toCoord);
      if (nm) {
        for (const ee of edgesToName) ee.name = nm;
        nameCount++;
      }
    }
  }

  return { key, nameCount };
}

function nameCellOf([lng, lat]: LngLat): number {
  return (Math.floor(lng / 0.001) + 4096) * 16384 + (Math.floor(lat / 0.001) + 4096);
}

export function emptyGraph(): RoutingGraph {
  return makeGraph();
}
