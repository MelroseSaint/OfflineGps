import { encodeTile, type TestFeature } from './mvt';
import { tileKey, type TileCoord } from '../../src/lib/tiles';

export interface GridSpec {
  /** Tile to generate. */
  tile: TileCoord;
  extent?: number;
  /** Number of horizontal + vertical streets. */
  n?: number;
  /** Make vertical avenues oneway northbound (1 = geometry direction). */
  onewayAvenues?: boolean;
  names?: boolean;
}

/**
 * A synthetic grid city: horizontal "streets" (residential, two-way) and
 * vertical "avenues" (secondary, optionally oneway). Coordinates are absolute
 * lng/lat so tiles snap-stitch across boundaries.
 */
export function makeGridTile(spec: GridSpec): { key: string; data: ArrayBuffer } {
  const extent = spec.extent ?? 4096;
  const n = spec.n ?? 8;
  const { sw, ne } = { sw: [0, 0] as [number, number], ne: [0, 0] as [number, number] };
  void sw;
  void ne;
  // Tile bounds from its coordinates:
  const t = spec.tile;
  const nTiles = 2 ** t.z;
  const lng0 = (t.x / nTiles) * 360 - 180;
  const lng1 = ((t.x + 1) / nTiles) * 360 - 180;
  const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * t.y) / nTiles))) * 180) / Math.PI;
  const lat0 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 1)) / nTiles))) * 180) / Math.PI;

  const toLng = (x: number): number => lng0 + (x / extent) * (lng1 - lng0);
  const toLat = (y: number): number => lat0 + (y / extent) * (lat1 - lat0);

  const roads: TestFeature[] = [];
  const step = extent / n;

  // Streets are emitted as LONG lines (one feature per street), mimicking
  // planetiler's way-merging: junctions sit at interior vertices shared with
  // crossing streets, not at feature endpoints. This exercises the real
  // topology-restoration path (nodes at every shared vertex).

  // Horizontal streets (two-way residential), named "1st Main St"...
  for (let i = 0; i <= n; i++) {
    const y = i * step;
    const points: [number, number][] = [];
    for (let j = 0; j <= n; j++) points.push([j * step, y]);
    roads.push({
      type: 2,
      props: { class: 'residential', oneway: 0, name: `${i + 1} Main St` },
      points,
    });
  }
  // Vertical avenues (secondary). When onewayAvenues is set, they alternate
  // direction (like a real one-way grid): even northbound, odd southbound.
  for (let i = 0; i <= n; i++) {
    const x = i * step;
    const oneway = spec.onewayAvenues ? (i % 2 === 0 ? 1 : -1) : 0;
    const points: [number, number][] = [];
    for (let j = 0; j <= n; j++) points.push([x, j * step]);
    roads.push({
      type: 2,
      props: { class: 'secondary', oneway, name: `${i + 1} Ave` },
      points,
    });
  }

  // A few places for the search index.
  const places: TestFeature[] = [
    { type: 1, props: { name: 'Harrisburg', class: 'city' }, points: [[extent / 2, extent / 2]] },
    { type: 1, props: { name: 'Midtown', class: 'suburb' }, points: [[extent / 4, extent / 4]] },
  ];

  const data = encodeTile([
    { name: 'transportation', features: roads, extent },
    { name: 'place', features: places, extent },
  ]);
  return { key: tileKey(t), data };
}
