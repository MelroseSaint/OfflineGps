import { readMvt } from '../mvt/decode';
import { parseTileKey, tileToLngLatBounds } from '../tiles';
import type { SearchDoc } from '../storage/db';

const PLACE_BOOST: Record<string, number> = {
  city: 120,
  town: 90,
  village: 70,
  hamlet: 55,
  suburb: 60,
  neighbourhood: 50,
  borough: 65,
  municipality: 75,
};

const PLACE_KIND: Record<string, SearchDoc['kind']> = {
  city: 'city',
  town: 'town',
  village: 'village',
  hamlet: 'hamlet',
  suburb: 'suburb',
  neighbourhood: 'suburb',
  borough: 'suburb',
};

/**
 * Build searchable documents from a vector tile:
 *  - places (place layer) at all zooms;
 *  - street names (transportation_name layer, or inline names) at z13+;
 *  - POIs (poi layer) at z14+.
 * Documents are tagged with their tile so eviction can remove them.
 */
export function extractSearchDocs(key: string, data: ArrayBuffer): SearchDoc[] {
  const { z, x, y } = parseTileKey(key);
  const bounds = tileToLngLatBounds({ z, x, y });
  let layers;
  try {
    layers = readMvt(data);
  } catch {
    return [];
  }
  const extentOf = (name: string): number => layers.find((l) => l.name === name)?.extent ?? 4096;
  const toLng = (v: { z: number; x: number; y: number }, xx: number, extent: number): number => {
    const { sw, ne } = tileToLngLatBounds({ z: v.z, x: v.x, y: v.y });
    return sw[0] + (xx / extent) * (ne[0] - sw[0]);
  };
  const toLat = (v: { z: number; x: number; y: number }, yy: number, extent: number): number => {
    const { sw, ne } = tileToLngLatBounds({ z: v.z, x: v.x, y: v.y });
    return sw[1] + (yy / extent) * (ne[1] - sw[1]);
  };

  const docs: SearchDoc[] = [];

  for (const layer of layers) {
    const extent = layer.extent;
    // Geometry is a flat list of points; for lines take the midpoint,
    // for points the single vertex.
    const firstPoint = (paths: [number, number][]): [number, number] | null => {
      if (paths.length === 0) return null;
      if (paths.length >= 4) {
        const mid = paths[Math.floor(paths.length / 2)];
        return [mid[0], mid[1]];
      }
      return [paths[0][0], paths[0][1]];
    };

    const isRoads = layer.name === 'transportation' || layer.name === 'road';
    if (layer.name === 'place') {
      for (const f of layer.features) {
        const name = f.props.name;
        if (typeof name !== 'string' || !name) continue;
        const cls = String(f.props.class ?? 'place');
        const pt = firstPoint(f.paths);
        if (!pt) continue;
        docs.push({
          id: `${key}|p|${name}`,
          name,
          norm: name.toLowerCase(),
          kind: PLACE_KIND[cls] ?? 'hamlet',
          lat: toLat({ z, x, y }, pt[1], extent),
          lng: toLng({ z, x, y }, pt[0], extent),
          tile: key,
          boost: PLACE_BOOST[cls] ?? 40,
          context: typeof f.props.state === 'string' ? f.props.state : undefined,
        });
      }
    } else if ((layer.name === 'transportation_name' || isRoads) && z >= 12) {
      // OpenMapTiles keeps street names in a parallel layer; Shortbread-style
      // builds carry them inline on the roads layer. Support both.
      const seen = new Set<string>();
      for (const f of layer.features) {
        const name = f.props.name;
        if (typeof name !== 'string' || !name) continue;
        const dedupeKey = name.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const pt = firstPoint(f.paths);
        if (!pt) continue;
        docs.push({
          id: `${key}|s|${name}`,
          name,
          norm: name.toLowerCase(),
          kind: 'street',
          lat: toLat({ z, x, y }, pt[1], extent),
          lng: toLng({ z, x, y }, pt[0], extent),
          tile: key,
          boost: 25,
        });
      }
    } else if (layer.name === 'poi' && z >= 14) {
      for (const f of layer.features) {
        const name = f.props.name;
        if (typeof name !== 'string' || !name) continue;
        const pt = firstPoint(f.paths);
        if (!pt) continue;
        const sub = String(f.props.subclass ?? f.props.class ?? 'poi');
        docs.push({
          id: `${key}|a|${name}|${f.id ?? 0}`,
          name,
          norm: name.toLowerCase(),
          kind: 'poi',
          lat: toLat({ z, x, y }, pt[1], extent),
          lng: toLng({ z, x, y }, pt[0], extent),
          tile: key,
          boost: 12,
          context: sub,
        });
      }
    }
  }

  void extentOf;
  return docs;
}
