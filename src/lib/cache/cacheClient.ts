import type { EvictionCtx, Pressure } from './budget';
import type { BBox } from '../geo';

export type CacheEvent =
  | { type: 'prefetch-progress'; jobId: number; done: number; total: number; phase: string }
  | { type: 'prefetch-done'; jobId: number; stored: number; failed: number; bytes: number }
  | { type: 'evicted'; removed: number; freedBytes: number; pressure: Pressure }
  | { type: 'cleared'; freedBytes: number }
  | { type: 'indexed'; key: string }
  | { type: 'download-progress'; areaId: string; done: number; total: number }
  | { type: 'download-done'; areaId: string; tiles: number; bytes: number; error?: string };

type Listener = (e: CacheEvent) => void;

export interface AreaDownloadRequest {
  id: string;
  name: string;
  box: BBox;
  maxZoom: number;
}

interface CacheWorkerRequest {
  type: string;
  [k: string]: unknown;
}

class CacheClient {
  private worker: Worker | null = null;
  private listeners = new Set<Listener>();
  private jobSeq = 1;

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: CacheEvent): void {
    for (const l of this.listeners) l(e);
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./cacheWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<CacheEvent>) => this.emit(ev.data);
    this.worker = w;
    return w;
  }

  private post(msg: CacheWorkerRequest, transfer: ArrayBuffer[] = []): void {
    this.ensure().postMessage(msg, transfer);
  }

  /** Queue background prefetch of tiles (smart tier unless areaId given). */
  prefetch(keys: string[], phase: string, opts?: { areaId?: string; tier?: 'smart' | 'permanent' }): number {
    const jobId = this.jobSeq++;
    this.post({ type: 'prefetch', jobId, keys, phase, areaId: opts?.areaId, tier: opts?.tier ?? 'smart' });
    return jobId;
  }

  indexTile(key: string, data: ArrayBuffer): void {
    this.post({ type: 'index', key, data }, [data]);
  }

  evict(ctx: EvictionCtx): void {
    this.post({ type: 'evict', ctx });
  }

  clearSmart(): void {
    this.post({ type: 'clearSmart' });
  }

  downloadArea(req: AreaDownloadRequest): void {
    this.post({ type: 'downloadArea', ...req });
  }

  deleteArea(areaId: string): void {
    this.post({ type: 'deleteArea', areaId });
  }

  pin(keys: string[], routeId: string): void {
    if (keys.length > 0) this.post({ type: 'pin', routeId, keys });
  }

  unpin(routeId: string): void {
    this.post({ type: 'unpin', routeId });
  }
}

export const cacheClient = new CacheClient();
