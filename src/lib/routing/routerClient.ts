import type { LngLat } from '../geo';
import type { Route } from '../types';
import type { RouterReply, RouterRequest } from './routerWorker';

export type RouteResult =
  | { ok: true; route: Route }
  | { ok: false; reason: 'no-origin' | 'no-destination' | 'no-path' };

export interface TilePayload {
  key: string;
  data: ArrayBuffer;
}

interface Pending {
  resolve: (r: RouterReply) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RouterClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./routerWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<RouterReply & { id?: number }>) => {
      const id = (ev.data as { id?: number }).id;
      if (id != null) {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.resolve(ev.data);
        }
      }
    };
    w.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(e);
      this.pending.clear();
    };
    this.worker = w;
    return w;
  }

  private request(msg: RouterRequest & { id: number }, transfer: ArrayBuffer[], timeoutMs: number): Promise<RouterReply> {
    const w = this.ensure();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error('router timeout'));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer });
      w.postMessage(msg, transfer);
    });
  }

  async load(tiles: TilePayload[]): Promise<{ tiles: number; edges: number; nodes: number }> {
    if (tiles.length === 0) return { tiles: 0, edges: 0, nodes: 0 };
    const id = this.nextId++;
    try {
      const r = await this.request({ type: 'load', id, tiles }, tiles.map((t) => t.data), 120_000);
      if (r.type === 'loaded') return { tiles: r.tiles, edges: r.edges, nodes: r.nodes };
      return { tiles: 0, edges: 0, nodes: 0 };
    } catch {
      return { tiles: 0, edges: 0, nodes: 0 };
    }
  }

  async route(origin: LngLat, dest: LngLat, snapMaxM?: number, mode?: 'car' | 'bicycle' | 'foot'): Promise<RouteResult> {
    const id = this.nextId++;
    try {
      // Long-corridor A* (350+ km trips) can legitimately run past a minute
      // in the worker; the UI shows "Rerouting…" meanwhile.
      const r = await this.request({ type: 'route', id, origin, dest, snapMaxM, mode }, [], 120_000);
      if (r.type === 'route') {
        return r.ok ? { ok: true, route: r.route } : { ok: false, reason: r.reason };
      }
      return { ok: false, reason: 'no-path' };
    } catch {
      return { ok: false, reason: 'no-path' };
    }
  }

  /** Drop low-zoom (coarse) tiles from the worker graph, keeping those near a path. */
  dropCoarse(maxZoom: number, keepNear?: LngLat[], keepRadiusM?: number): void {
    if (!this.worker) return;
    const id = this.nextId++;
    void this.request({ type: 'drop-coarse', id, maxZoom, keepNear, keepRadiusM }, [], 30_000).catch(() => {});
  }

  /** Debug/diagnostic: worker graph size + optional component size near a point. */
  async stats(near?: LngLat): Promise<{ liveEdges: number; nodes: number; component?: number } | null> {
    if (!this.worker) return null;
    const id = this.nextId++;
    try {
      const r = await this.request({ type: 'stats', id, near }, [], 30_000);
      if (r.type === 'stats') return { liveEdges: r.liveEdges, nodes: r.nodes, component: r.component };
      return null;
    } catch {
      return null;
    }
  }

  prune(center: LngLat, radiusM: number): void {
    if (!this.worker) return;
    const id = this.nextId++;
    void this.request({ type: 'prune', id, center, radiusM }, [], 30_000).catch(() => {});
  }

  reset(): void {
    if (!this.worker) return;
    const id = this.nextId++;
    void this.request({ type: 'reset', id }, [], 10_000).catch(() => {});
  }
}

export const router = new RouterClient();
