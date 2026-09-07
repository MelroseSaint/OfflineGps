/// <reference lib="webworker" />
import type { BBox } from '../geo';
import { getDB } from '../storage/db';
import { geostore } from '../storage/geostore';
import { tileUrlFor, tilesInBBox, type TileCoord } from '../tiles';
import { extractSearchDocs } from '../search/extract';
import { planEviction, type EvictMeta } from './budget';

interface PrefetchMsg {
  type: 'prefetch';
  jobId: number;
  keys: string[];
  phase: string;
  tier?: 'smart' | 'permanent';
  areaId?: string;
}
interface IndexMsg {
  type: 'index';
  key: string;
  data: ArrayBuffer;
}
interface EvictMsg {
  type: 'evict';
  ctx: {
    budgetBytes: number;
    autoCleanup: boolean;
    route?: [number, number][] | null;
    posAlongM?: number | null;
    corridorM: number;
    keepBehindM: number;
  };
}
interface ClearSmartMsg {
  type: 'clearSmart';
}
interface DownloadAreaMsg {
  type: 'downloadArea';
  id: string;
  name: string;
  box: BBox;
  maxZoom: number;
}
interface DeleteAreaMsg {
  type: 'deleteArea';
  areaId: string;
}
interface PinMsg {
  type: 'pin';
  routeId: string;
  keys: string[];
}
interface UnpinMsg {
  type: 'unpin';
  routeId: string;
}

type Req =
  | PrefetchMsg
  | IndexMsg
  | EvictMsg
  | ClearSmartMsg
  | DownloadAreaMsg
  | DeleteAreaMsg
  | PinMsg
  | UnpinMsg;

async function fetchTileData(key: string): Promise<ArrayBuffer | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  try {
    const res = await fetch(await tileUrlFor(key), { mode: 'cors' });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

async function storeSearchDocs(key: string, data: ArrayBuffer): Promise<void> {
  const docs = extractSearchDocs(key, data);
  if (docs.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('search-index', 'readwrite');
  for (const d of docs) void tx.store.put(d);
  await tx.done;
}

async function removeSearchDocs(keys: Set<string>): Promise<void> {
  if (keys.size === 0) return;
  const db = await getDB();
  const tx = db.transaction('search-index', 'readwrite');
  let cursor = await tx.store.openCursor();
  const del: string[] = [];
  while (cursor) {
    if (keys.has(cursor.value.tile)) del.push(cursor.key as string);
    cursor = await cursor.continue();
  }
  for (const id of del) await tx.store.delete(id);
  await tx.done;
}

async function doPrefetch(msg: PrefetchMsg): Promise<void> {
  const tier = msg.tier ?? 'smart';
  let stored = 0;
  let failed = 0;
  let bytes = 0;
  let done = 0;
  const total = msg.keys.length;
  const CONCURRENCY = 4;
  let idx = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const i = idx++;
      if (i >= total) return;
      const key = msg.keys[i];
      try {
        const existing = await geostore.getTile(key);
        if (!existing || existing.data.byteLength === 0) {
          const data = await fetchTileData(key);
          if (data && data.byteLength > 0) {
            await geostore.putTile(key, data, {
              tier,
              fetchedAt: Date.now(),
              lastAccess: Date.now(),
              areaId: tier === 'permanent' ? msg.areaId : undefined,
            });
            await storeSearchDocs(key, data);
            stored++;
            bytes += data.byteLength;
          } else {
            failed++;
          }
        }
      } catch {
        failed++;
      }
      done++;
      if (done % 5 === 0 || done === total) {
        post({ type: 'prefetch-progress', jobId: msg.jobId, done, total, phase: msg.phase });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, run));
  post({ type: 'prefetch-done', jobId: msg.jobId, stored, failed, bytes });
}

async function doEvict(msg: EvictMsg): Promise<void> {
  await geostore.recomputeUsage();
  const metas = await geostore.allTileMeta();
  const evictMetas: EvictMeta[] = metas.map((m) => {
    const [, zs, xs, ys] = m.key.split('/');
    return {
      key: m.key,
      tier: m.tier,
      size: m.size,
      lastAccess: m.lastAccess,
      pinnedBy: m.pinnedBy,
      z: +zs,
      x: +xs,
      y: +ys,
    };
  });
  const plan = planEviction(evictMetas, {
    budgetBytes: msg.ctx.budgetBytes,
    autoCleanup: msg.ctx.autoCleanup,
    nowMs: Date.now(),
    route: msg.ctx.route ?? null,
    posAlongM: msg.ctx.posAlongM ?? null,
    corridorM: msg.ctx.corridorM,
    keepBehindM: msg.ctx.keepBehindM,
  });
  if (plan.evict.length > 0) {
    await geostore.deleteTiles(plan.evict);
    await removeSearchDocs(new Set(plan.evict));
  }
  post({
    type: 'evicted',
    removed: plan.evict.length,
    freedBytes: 0,
    pressure: plan.pressure,
  });
}

async function doClearSmart(): Promise<void> {
  await geostore.recomputeUsage();
  const metas = await geostore.allTileMeta();
  const keys = metas.filter((m) => m.tier === 'smart').map((m) => m.key);
  const bytes = metas
    .filter((m) => m.tier === 'smart')
    .reduce((s, m) => s + m.size, 0);
  await geostore.deleteTiles(keys);
  await removeSearchDocs(new Set(keys));
  post({ type: 'cleared', freedBytes: bytes });
}

async function doDownloadArea(msg: DownloadAreaMsg): Promise<void> {
  const keys: string[] = [];
  for (let z = 4; z <= msg.maxZoom; z++) {
    const tiles: TileCoord[] = tilesInBBox(msg.box, z);
    for (const t of tiles) keys.push(`planet/${t.z}/${t.x}/${t.y}`);
  }
  if (keys.length > 6000) {
    post({
      type: 'download-done',
      areaId: msg.id,
      tiles: 0,
      bytes: 0,
      error: `Area too large (${keys.length} tiles). Choose a smaller area or lower detail.`,
    });
    return;
  }
  let done = 0;
  let bytes = 0;
  const CONCURRENCY = 6;
  let idx = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const i = idx++;
      if (i >= keys.length) return;
      const key = keys[i];
      const existing = await geostore.getTile(key);
      if (!existing || existing.data.byteLength === 0) {
        const data = await fetchTileData(key);
        if (data && data.byteLength > 0) {
          await geostore.putTile(key, data, {
            tier: 'permanent',
            fetchedAt: Date.now(),
            lastAccess: Date.now(),
            areaId: msg.id,
          });
          await storeSearchDocs(key, data);
          bytes += data.byteLength;
        }
      }
      done++;
      if (done % 10 === 0 || done === keys.length) {
        post({ type: 'download-progress', areaId: msg.id, done, total: keys.length });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, run));
  await geostore.saveArea({
    id: msg.id,
    name: msg.name,
    kind: 'custom',
    tileKeys: keys,
    createdAt: Date.now(),
    sizeBytes: bytes,
  });
  post({ type: 'download-done', areaId: msg.id, tiles: keys.length, bytes });
}

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'prefetch':
      void doPrefetch(msg);
      break;
    case 'index':
      void storeSearchDocs(msg.key, msg.data).then(() => post({ type: 'indexed', key: msg.key }));
      break;
    case 'evict':
      void doEvict(msg);
      break;
    case 'clearSmart':
      void doClearSmart();
      break;
    case 'downloadArea':
      void doDownloadArea(msg);
      break;
    case 'deleteArea':
      void geostore.deleteArea(msg.areaId);
      break;
    case 'pin':
      void geostore.pinTiles(msg.keys, msg.routeId);
      break;
    case 'unpin':
      void geostore.unpinTiles(msg.routeId);
      break;
  }
};
