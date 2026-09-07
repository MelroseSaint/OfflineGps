import type { BBox, LngLat } from './geo';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
/** Custom MapLibre protocol through which every tile flows (cache-first). */
export const TILE_PROTOCOL = 'smartcache';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const FALLBACK_TEMPLATE = 'https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf';

let tileTemplate: string | null = null;
let templatePromise: Promise<string> | null = null;

/**
 * OpenFreeMap publishes tiles under a dated snapshot path (e.g.
 * /planet/20260830_080001_pt/{z}/{x}/{y}.pbf) that rotates with new planet
 * builds, so the template is discovered from the TileJSON at runtime and
 * cached (localStorage on the main thread; per-process in workers).
 */
export async function ensureTileTemplate(): Promise<string> {
  if (tileTemplate) return tileTemplate;
  if (templatePromise) return templatePromise;
  templatePromise = (async () => {
    try {
      const stored = globalThis.localStorage?.getItem('wayline.tileTemplate');
      if (stored) {
        tileTemplate = stored;
        return tileTemplate;
      }
    } catch {
      // workers have no localStorage — fall through to the network
    }
    try {
      const res = await fetch(TILEJSON_URL, { mode: 'cors' });
      const json = (await res.json()) as { tiles?: string[] };
      const t = json.tiles?.[0];
      if (t && t.includes('{z}')) {
        tileTemplate = t;
        try {
          globalThis.localStorage?.setItem('wayline.tileTemplate', t);
        } catch {
          // non-fatal
        }
      }
    } catch {
      // offline — fall back below
    }
    return tileTemplate ?? FALLBACK_TEMPLATE;
  })();
  return templatePromise;
}

/** Concrete network URL for a cache key (planet/z/x/y). */
export async function tileUrlFor(key: string): Promise<string> {
  const template = await ensureTileTemplate();
  const { z, x, y } = parseTileKey(key);
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export function tileKey(t: TileCoord, source = 'planet'): string {
  return `${source}/${t.z}/${t.x}/${t.y}`;
}

export function parseTileKey(key: string): TileCoord & { source: string } {
  const [source, z, x, y] = key.split('/');
  return { source, z: +z, x: +x, y: +y };
}

export function lngLatToTile(p: LngLat, z: number): TileCoord {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, p[1]));
  const xt = ((p[0] + 180) / 360) * n;
  const yt =
    ((1 - Math.log(Math.tan(clampedLat * (Math.PI / 180)) + 1 / Math.cos(clampedLat * (Math.PI / 180))) / Math.PI) / 2) * n;
  return { z, x: Math.floor(xt), y: Math.floor(yt) };
}

export function tileToLngLatBounds(t: TileCoord): { sw: LngLat; ne: LngLat } {
  const n = 2 ** t.z;
  const lng0 = (t.x / n) * 360 - 180;
  const lng1 = ((t.x + 1) / n) * 360 - 180;
  const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * t.y) / n))) * 180) / Math.PI;
  const lat0 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 1)) / n))) * 180) / Math.PI;
  return { sw: [lng0, lat0], ne: [lng1, lat1] };
}

export function tileCenter(t: TileCoord): LngLat {
  const { sw, ne } = tileToLngLatBounds(t);
  return [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2];
}

/** Approximate tile width in meters at a given latitude. */
export function tileWidthM(t: Pick<TileCoord, 'z'>, lat = 40): number {
  return (40075016.7 * Math.cos((lat * Math.PI) / 180)) / 2 ** t.z;
}

export function tilesInBBox(box: BBox, z: number): TileCoord[] {
  const min = lngLatToTile([box.minLng, box.maxLat], z);
  const max = lngLatToTile([box.maxLng, box.minLat], z);
  const out: TileCoord[] = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      if (y >= 0 && y < 2 ** z) out.push({ z, x: ((x % 2 ** z) + 2 ** z) % 2 ** z, y });
    }
  }
  return out;
}

/** Meters per pixel for a given zoom + latitude (256px tile convention). */
export function metersPerPixel(z: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}
