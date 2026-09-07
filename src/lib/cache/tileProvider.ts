import { net } from '../net';
import { geostore } from '../storage/geostore';
import { tileUrlFor } from '../tiles';
import { cacheClient } from './cacheClient';

export class TileUnavailableError extends Error {
  constructor(public key: string) {
    super(`tile unavailable offline: ${key}`);
  }
}

class TileProvider {
  private inflight = new Map<string, Promise<ArrayBuffer | null>>();

  async obtain(key: string): Promise<ArrayBuffer | null> {
    const cached = await geostore.getTile(key);
    if (cached) {
      if (cached.data.byteLength === 0) {
        // Repair legacy zero-byte entries (e.g. from a stale tile template).
        await geostore.deleteTiles([key]);
      } else {
        return cached.data;
      }
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = this.fetchAndStore(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetchAndStore(key: string): Promise<ArrayBuffer | null> {
    let url: string;
    try {
      url = await tileUrlFor(key);
    } catch {
      return null;
    }
    try {
      if (net.state === 'offline') return null;
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) {
        net.notifyFetchFailure();
        return null;
      }
      const data = await res.arrayBuffer();
      if (data.byteLength === 0) {
        // Empty body — treat as a failed fetch (stale template, gateway quirk).
        return null;
      }
      await geostore.putTile(key, data, {
        tier: 'smart',
        fetchedAt: Date.now(),
        lastAccess: Date.now(),
      });
      net.notifyFetchSuccess();
      // Feed the search index (worker parses its own copy).
      cacheClient.indexTile(key, data.slice(0));
      return data;
    } catch {
      net.notifyFetchFailure();
      return null;
    }
  }

  /** Fetch a set of keys with bounded concurrency; reports progress. */
  async obtainMany(
    keys: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, ArrayBuffer>> {
    const out = new Map<string, ArrayBuffer>();
    let done = 0;
    const CONCURRENCY = 6;
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, keys.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= keys.length) return;
        const key = keys[i];
        const data = await this.obtain(key);
        if (data) out.set(key, data);
        done++;
        onProgress?.(done, keys.length);
      }
    });
    await Promise.all(workers);
    return out;
  }
}

export const tileProvider = new TileProvider();
