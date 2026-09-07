import type { BBox } from '../geo';
import type { TileCoord } from '../tiles';
import { tileKey } from '../tiles';
import { getDB, type AreaMeta, type SavedPlace, type TileMeta } from './db';

export interface UsageStats {
  smartBytes: number;
  permanentBytes: number;
  smartTiles: number;
  permanentTiles: number;
}

/**
 * GeoStore — the single storage abstraction for all geographic data.
 *
 * Layers underneath: Cache Storage (PWA assets, via the service worker),
 * IndexedDB (tiles + metadata, below), localStorage-free settings in IDB.
 * Nothing else in the app touches IndexedDB directly.
 */
export class GeoStore {
  constructor(private readonly dbName = 'wayline') {}

  private usage: UsageStats = { smartBytes: 0, permanentBytes: 0, smartTiles: 0, permanentTiles: 0 };
  private usageLoaded = false;

  async init(): Promise<void> {
    if (this.usageLoaded) return;
    await this.recomputeUsage();
    this.usageLoaded = true;
  }

  get usageStats(): UsageStats {
    return this.usage;
  }

  async recomputeUsage(): Promise<UsageStats> {
    const db = await getDB(this.dbName);
    const tx = db.transaction('tiles');
    let smartBytes = 0;
    let permanentBytes = 0;
    let smartTiles = 0;
    let permanentTiles = 0;
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const m = cursor.value.meta as TileMeta;
      if (m.tier === 'permanent') {
        permanentBytes += m.size;
        permanentTiles++;
      } else {
        smartBytes += m.size;
        smartTiles++;
      }
      cursor = await cursor.continue();
    }
    this.usage = { smartBytes, permanentBytes, smartTiles, permanentTiles };
    return this.usage;
  }

  async getTile(key: string): Promise<{ meta: TileMeta; data: ArrayBuffer } | undefined> {
    const db = await getDB(this.dbName);
    const rec = await db.get('tiles', key);
    if (rec) {
      // Touch lastAccess lazily (no await — metadata write can trail).
      void db
        .put('tiles', { ...rec, meta: { ...rec.meta, lastAccess: Date.now() } })
        .catch(() => {});
    }
    return rec;
  }

  async putTile(
    key: string,
    data: ArrayBuffer,
    meta: Omit<TileMeta, 'key' | 'size'>,
  ): Promise<void> {
    const db = await getDB(this.dbName);
    const prev = await db.get('tiles', key);
    const size = data.byteLength;
    if (prev) {
      const d = size - prev.meta.size;
      if (prev.meta.tier === 'permanent') this.usage.permanentBytes = Math.max(0, this.usage.permanentBytes + d);
      else this.usage.smartBytes = Math.max(0, this.usage.smartBytes + d);
    } else if (meta.tier === 'permanent') {
      this.usage.permanentBytes += size;
      this.usage.permanentTiles++;
    } else {
      this.usage.smartBytes += size;
      this.usage.smartTiles++;
    }
    await db.put('tiles', { key, data, meta: { ...meta, key, size } });
  }

  async deleteTiles(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await getDB(this.dbName);
    const tx = db.transaction('tiles', 'readwrite');
    for (const key of keys) {
      const rec = await tx.store.get(key);
      if (rec) {
        if (rec.meta.tier === 'permanent') {
          this.usage.permanentBytes -= rec.meta.size;
          this.usage.permanentTiles--;
        } else {
          this.usage.smartBytes -= rec.meta.size;
          this.usage.smartTiles--;
        }
        await tx.store.delete(key);
      }
    }
    await tx.done;
  }

  async allTileMeta(): Promise<TileMeta[]> {
    const db = await getDB(this.dbName);
    const out: TileMeta[] = [];
    let cursor = await db.transaction('tiles').store.openCursor();
    while (cursor) {
      out.push(cursor.value.meta);
      cursor = await cursor.continue();
    }
    return out;
  }

  async pinTiles(keys: string[], routeId: string): Promise<void> {
    const db = await getDB(this.dbName);
    const tx = db.transaction('tiles', 'readwrite');
    for (const key of keys) {
      const rec = await tx.store.get(key);
      if (rec && rec.meta.tier === 'smart') {
        await tx.store.put({ ...rec, meta: { ...rec.meta, pinnedBy: routeId } });
      }
    }
    await tx.done;
  }

  async unpinTiles(routeId: string): Promise<void> {
    const db = await getDB(this.dbName);
    const tx = db.transaction('tiles', 'readwrite');
    let cursor = await tx.store.openCursor();
    const updates: { key: string; meta: TileMeta }[] = [];
    while (cursor) {
      if (cursor.value.meta.pinnedBy === routeId) {
        updates.push({ key: cursor.key as string, meta: { ...cursor.value.meta, pinnedBy: undefined } });
      }
      cursor = await cursor.continue();
    }
    for (const u of updates) {
      const rec = await tx.store.get(u.key);
      if (rec) await tx.store.put({ ...rec, meta: { ...rec.meta, pinnedBy: undefined } });
    }
    await tx.done;
  }

  async saveArea(area: AreaMeta): Promise<void> {
    const db = await getDB(this.dbName);
    await db.put('areas', area);
  }

  async getArea(id: string): Promise<AreaMeta | undefined> {
    const db = await getDB(this.dbName);
    return db.get('areas', id);
  }

  async listAreas(): Promise<AreaMeta[]> {
    const db = await getDB(this.dbName);
    return db.getAll('areas');
  }

  async deleteArea(id: string): Promise<void> {
    const db = await getDB(this.dbName);
    const area = await db.get('areas', id);
    if (!area) return;
    await this.deleteTiles(area.tileKeys);
    await db.delete('areas', id);
  }

  async savePlace(p: SavedPlace): Promise<void> {
    const db = await getDB(this.dbName);
    await db.put('saved-places', p);
  }

  async listPlaces(): Promise<SavedPlace[]> {
    const db = await getDB(this.dbName);
    return db.getAll('saved-places');
  }

  async deletePlace(id: string): Promise<void> {
    const db = await getDB(this.dbName);
    await db.delete('saved-places', id);
  }

  /** Tiles intersecting a bbox (metadata only). */
  async tilesInBBox(box: BBox): Promise<TileMeta[]> {
    const all = await this.allTileMeta();
    return all.filter((m) => {
      const [, zs, xs, ys] = m.key.split('/');
      const z = +zs;
      const x = +xs;
      const y = +ys;
      const n = 2 ** z;
      const lng0 = (x / n) * 360 - 180;
      const lng1 = ((x + 1) / n) * 360 - 180;
      const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
      const lat0 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
      return !(box.maxLng < lng0 || box.minLng > lng1 || box.maxLat < lat0 || box.minLat > lat1);
    });
  }
}

export const geostore = new GeoStore();
