import type { SearchResult } from '../types';

interface LocalDoc {
  name: string;
  kind: string;
  lat: number;
  lng: number;
  context?: string;
}

class SearchClient {
  private worker: Worker | null = null;
  private pending = new Map<number, (docs: LocalDoc[]) => void>();
  private nextId = 1;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<{ type: string; id?: number; docs?: LocalDoc[] }>) => {
      if (ev.data.type === 'query-result' && ev.data.id != null) {
        const p = this.pending.get(ev.data.id);
        if (p) {
          this.pending.delete(ev.data.id);
          p(ev.data.docs ?? []);
        }
      }
    };
    this.worker = w;
    return w;
  }

  async local(text: string, center?: [number, number]): Promise<SearchResult[]> {
    const w = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, (docs) => {
        resolve(
          docs.map((d, i) => ({
            id: `local-${id}-${i}`,
            name: d.name,
            detail: d.context,
            lat: d.lat,
            lng: d.lng,
            source: 'local' as const,
            kind: d.kind,
          })),
        );
      });
      w.postMessage({ type: 'query', id, text, center });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve([]);
        }
      }, 4000);
    });
  }

  /** Ask the worker to rebuild its in-memory index from IndexedDB. */
  refresh(): void {
    this.ensure().postMessage({ type: 'rebuild' });
  }

  async photon(text: string, center?: [number, number]): Promise<SearchResult[]> {
    try {
      const params = new URLSearchParams({ q: text, limit: '12', lang: 'en' });
      if (center) {
        params.set('lon', String(center[0].toFixed(4)));
        params.set('lat', String(center[1].toFixed(4)));
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return [];
      const json = (await res.json()) as {
        features: {
          geometry: { coordinates: [number, number] };
          properties: Record<string, string | number>;
        }[];
      };
      return json.features.map((f, i) => {
        const p = f.properties;
        const name = (p.name as string) || (p.label as string) || text;
        const detailParts = [p.street as string, p.city as string, p.state as string].filter(
          (x) => x && x !== name,
        );
        return {
          id: `photon-${i}-${p.osm_id ?? i}`,
          name,
          detail: (p.label as string) || detailParts.join(', '),
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0],
          source: 'online' as const,
          kind: p.osm_value as string | undefined,
        };
      });
    } catch {
      return [];
    }
  }

  /** Merged search: Photon when online, local index always. */
  async search(
    text: string,
    center: [number, number] | undefined,
    opts: { geocodeOnline: boolean; online: boolean },
  ): Promise<{ results: SearchResult[]; degraded: boolean }> {
    const localTask = this.local(text, center);
    let onlineTask: Promise<SearchResult[]> | null = null;
    if (opts.online && opts.geocodeOnline) {
      onlineTask = this.photon(text, center);
    }
    const [local, online] = await Promise.all([
      localTask,
      onlineTask ?? Promise.resolve(null),
    ]);
    const results: SearchResult[] = [];
    const seen: SearchResult[] = [];
    const isDup = (r: SearchResult): boolean =>
      seen.some(
        (s) =>
          s.name.toLowerCase() === r.name.toLowerCase() &&
          Math.abs(s.lat - r.lat) < 0.02 &&
          Math.abs(s.lng - r.lng) < 0.02,
      );
    for (const r of [...(online ?? []), ...local]) {
      if (isDup(r)) continue;
      seen.push(r);
      results.push(r);
    }
    return {
      results: results.slice(0, 14),
      degraded: online === null && opts.online && opts.geocodeOnline ? false : online !== null && online.length === 0 && local.length > 0,
    };
  }
}

export const searchClient = new SearchClient();
