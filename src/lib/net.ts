import { Store } from './store';

export type NetState = 'online' | 'degraded' | 'offline';

/**
 * NetMonitor — reliable connectivity detection.
 *
 * navigator.onLine alone lies (captive portals, broken Wi-Fi), so state is
 * validated with a real request against the map tile origin. Any successful
 * tile fetch (reported by the cache layer) also confirms connectivity, and
 * repeated fetch failures while onLine trigger an immediate probe.
 *
 * States:
 *  - online:   probes and tile fetches succeed.
 *  - degraded: OS reports connectivity but our resources are unreachable.
 *  - offline:  OS reports no connectivity or probes fail with network errors.
 */
export class NetMonitor {
  readonly store = new Store<{
    state: NetState;
    probing: boolean;
    lastOkAt: number;
    lastChangeAt: number;
  }>({ state: 'online', probing: false, lastOkAt: Date.now(), lastChangeAt: Date.now() });

  private probeUrl = 'https://tiles.openfreemap.org/styles/liberty';
  private timer: ReturnType<typeof setInterval> | null = null;
  private failTimes: number[] = [];
  private probing = false;

  start(): void {
    window.addEventListener('online', () => void this.probe());
    window.addEventListener('offline', () => {
      // Trust the OS event immediately, but verify shortly after — it can lie both ways.
      this.apply('offline');
      setTimeout(() => void this.probe(), 1500);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.probe();
    });
    this.timer = setInterval(() => void this.probe(), 30_000);
    void this.probe();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get state(): NetState {
    return this.store.get().state;
  }

  private apply(state: NetState): void {
    const cur = this.store.get();
    if (cur.state === state) return;
    this.store.set({
      state,
      lastChangeAt: Date.now(),
      lastOkAt: state === 'online' ? Date.now() : cur.lastOkAt,
    });
  }

  /** Head-of-line probe against the tile origin. Serialized. */
  async probe(): Promise<NetState> {
    if (this.probing) return this.store.get().state;
    this.probing = true;
    this.store.set({ probing: true });
    try {
      if (!navigator.onLine) {
        this.apply('offline');
        return 'offline';
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`${this.probeUrl}?_probe=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      clearTimeout(t);
      this.failTimes = [];
      this.apply(res.ok ? 'online' : 'degraded');
      return res.ok ? 'online' : 'degraded';
    } catch (e) {
      const networkError =
        e instanceof TypeError || (e instanceof DOMException && e.name === 'AbortError');
      this.apply(networkError ? 'offline' : 'degraded');
      return networkError ? 'offline' : 'degraded';
    } finally {
      this.probing = false;
      this.store.set({ probing: false });
    }
  }

  /** Called by the cache layer on a successful network fetch. */
  notifyFetchSuccess(): void {
    this.failTimes = [];
    if (this.store.get().state !== 'online') this.apply('online');
  }

  /** Called by the cache layer on a failed network fetch. */
  notifyFetchFailure(): void {
    const now = Date.now();
    this.failTimes = this.failTimes.filter((t) => now - t < 30_000);
    this.failTimes.push(now);
    if (this.failTimes.length >= 3) {
      this.failTimes = [];
      void this.probe();
    }
  }
}

export const net = new NetMonitor();
