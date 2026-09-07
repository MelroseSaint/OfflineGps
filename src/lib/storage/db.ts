import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type Tier = 'smart' | 'permanent';

export interface TileMeta {
  key: string; // 'planet/z/x/y'
  tier: Tier;
  size: number;
  fetchedAt: number;
  lastAccess: number;
  /** Which route (if any) pinned this tile: routeId or 'active'. */
  pinnedBy?: string;
  /** Permanently-downloaded area id, when tier === 'permanent'. */
  areaId?: string;
}

export interface AreaMeta {
  id: string;
  name: string;
  kind: 'city' | 'region' | 'custom' | 'corridor';
  tileKeys: string[];
  createdAt: number;
  sizeBytes: number;
}

export interface SearchDoc {
  id: string;
  name: string;
  kind: 'city' | 'street' | 'poi' | 'address' | 'hamlet' | 'suburb' | 'village' | 'town';
  lat: number;
  lng: number;
  /** Lowercased searchable name. */
  norm: string;
  /** Parent context, e.g. "Pennsylvania" or a street's city. */
  context?: string;
  boost: number;
  /** Tile key this doc was extracted from (for eviction). */
  tile: string;
}

export interface SavedPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
}

export interface OutboxItem {
  id: string;
  kind: 'tile' | 'area';
  ref: string;
  createdAt: number;
}

export interface WaylineDB extends DBSchema {
  tiles: { key: string; value: { key: string; meta: TileMeta; data: ArrayBuffer } };
  'tiles-by-tier': { key: string; value: TileMeta[] };
  'tiles-by-area': { key: string; value: TileMeta[] };
  areas: { key: string; value: AreaMeta };
  'search-index': { key: string; value: SearchDoc };
  'saved-places': { key: string; value: SavedPlace };
  settings: { key: string; value: unknown };
  outbox: { key: string; value: OutboxItem };
}

const dbPromises = new Map<string, Promise<IDBPDatabase<WaylineDB>>>();

export function getDB(name = 'wayline'): Promise<IDBPDatabase<WaylineDB>> {
  let dbPromise = dbPromises.get(name);
  if (!dbPromise) {
    dbPromise = openDB<WaylineDB>(name, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('tiles')) {
          const s = db.createObjectStore('tiles', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('tiles-by-tier')) {
          db.createObjectStore('tiles-by-tier');
        }
        if (!db.objectStoreNames.contains('tiles-by-area')) {
          db.createObjectStore('tiles-by-area');
        }
        if (!db.objectStoreNames.contains('areas')) {
          db.createObjectStore('areas', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('search-index')) {
          db.createObjectStore('search-index', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('saved-places')) {
          db.createObjectStore('saved-places', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'id' });
        }
      },
    });
    dbPromises.set(name, dbPromise);
  }
  return dbPromise;
}

export async function loadSetting<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  return (await db.get('settings', key)) as T | undefined;
}

export async function saveSetting<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put('settings', value, key);
}
