import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { GeoStore } from '../src/lib/storage/geostore';
import { extractSearchDocs } from '../src/lib/search/extract';
import { makeGridTile } from './fixtures/grid';

const TILE = { z: 13, x: 4400, y: 2620 };

async function freshStore(): Promise<GeoStore> {
  const s = new GeoStore(`wayline-test-${Math.random().toString(36).slice(2)}`);
  await s.init();
  return s;
}

let store: GeoStore;

beforeEach(async () => {
  store = await freshStore();
});

describe('GeoStore', () => {
  it('stores and retrieves tiles with metadata', async () => {
    const data = new TextEncoder().encode('tiledata-abc').buffer as ArrayBuffer;
    await store.putTile('planet/13/1/2', data, {
      tier: 'smart',
      fetchedAt: 1,
      lastAccess: 1,
    });
    const rec = await store.getTile('planet/13/1/2');
    expect(rec).toBeDefined();
    expect(rec!.meta.tier).toBe('smart');
    expect(rec!.meta.size).toBe(data.byteLength);
    expect(new TextDecoder().decode(rec!.data)).toBe('tiledata-abc');
  });

  it('tracks usage separately for smart and permanent tiers', async () => {
    const d = new Uint8Array(1000).buffer;
    await store.putTile('planet/13/1/2', d, { tier: 'smart', fetchedAt: 1, lastAccess: 1 });
    await store.putTile('planet/13/1/3', d, { tier: 'smart', fetchedAt: 1, lastAccess: 1 });
    await store.putTile('planet/13/1/4', d, { tier: 'permanent', fetchedAt: 1, lastAccess: 1, areaId: 'a1' });
    const u = await store.recomputeUsage();
    expect(u.smartBytes).toBe(2000);
    expect(u.permanentBytes).toBe(1000);
    expect(u.smartTiles).toBe(2);
    expect(u.permanentTiles).toBe(1);
  });

  it('clearing smart tiles preserves permanent tiles', async () => {
    const d = new Uint8Array(500).buffer;
    await store.putTile('planet/13/1/2', d, { tier: 'smart', fetchedAt: 1, lastAccess: 1 });
    await store.putTile('planet/13/1/5', d, { tier: 'permanent', fetchedAt: 1, lastAccess: 1, areaId: 'a1' });
    const all = await store.allTileMeta();
    const smartKeys = all.filter((m) => m.tier === 'smart').map((m) => m.key);
    await store.deleteTiles(smartKeys);
    const u = await store.recomputeUsage();
    expect(u.smartTiles).toBe(0);
    expect(u.permanentTiles).toBe(1);
    expect(await store.getTile('planet/13/1/5')).toBeDefined();
  });

  it('pinning and unpinning route tiles', async () => {
    const d = new Uint8Array(10).buffer;
    await store.putTile('planet/13/1/2', d, { tier: 'smart', fetchedAt: 1, lastAccess: 1 });
    await store.pinTiles(['planet/13/1/2'], 'route-9');
    expect((await store.allTileMeta())[0].pinnedBy).toBe('route-9');
    await store.unpinTiles('route-9');
    expect((await store.allTileMeta())[0].pinnedBy).toBeUndefined();
  });

  it('extracts search docs from stored tiles and tags them for eviction', async () => {
    const { key, data } = makeGridTile({ tile: TILE, n: 4 });
    await store.putTile(key, data, { tier: 'smart', fetchedAt: 1, lastAccess: 1 });
    const docs = extractSearchDocs(key, data);
    expect(docs.length).toBeGreaterThan(2);
    expect(docs.every((d) => d.tile === key)).toBe(true);
    // Simulate eviction: delete tile + its docs.
    await store.deleteTiles([key]);
    expect(await store.getTile(key)).toBeUndefined();
  });
});
