import { positioner, type Fix } from '../lib/gps';
import { demoDrive } from '../lib/demo/simulate';
import { net, type NetState } from '../lib/net';
import { settings } from '../lib/settings';
import { Store, useStore } from '../lib/store';
export { useStore };
import { geostore } from '../lib/storage/geostore';
import { cacheClient, type CacheEvent } from '../lib/cache/cacheClient';
import { tileProvider } from '../lib/cache/tileProvider';
import { planPredictive } from '../lib/cache/corridor';
import { corridorKeysForRoute, planRoute, rerouteLocal } from '../lib/routing/planner';
import { NavigationEngine, type NavSnapshot } from '../lib/navigation/engine';
import { voice } from '../lib/voice';
import { searchClient } from '../lib/search/searchClient';
import { router } from '../lib/routing/routerClient';
import type { Pressure } from '../lib/cache/budget';
import type { Route, SearchResult } from '../lib/types';
import type { GpsStatus } from '../lib/gps';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error' | 'success';
}

export interface AppState {
  ready: boolean;
  net: NetState;
  gpsStatus: GpsStatus;
  gpsMessage?: string;
  fix: Fix | null;
  gpsStale: boolean;
  search: {
    text: string;
    busy: boolean;
    results: SearchResult[];
    degraded: boolean;
    searched: boolean;
  };
  /** Which endpoint the user is picking in the search panel. */
  pickTarget: 'dest' | 'origin' | null;
  selected: SearchResult | null;
  /** Custom origin chosen by user (null = 'My location'). */
  origin: SearchResult | null;
  routeDest: string | null;
  planning: { busy: boolean; phase: string; done: number; total: number; error?: string };
  route: Route | null;
  navActive: boolean;
  navSnap: NavSnapshot | null;
  arrived: boolean;
  camera: 'follow' | 'free' | 'overview';
  /** 3D view: pitched camera + building extrusions. */
  threeD: boolean;
  panel: 'none' | 'search' | 'settings';
  toasts: Toast[];
  cache: {
    smartBytes: number;
    permanentBytes: number;
    pressure: Pressure;
    downloading: { id: string; name: string; done: number; total: number } | null;
    lastDownloadError?: string;
  };
  demo: boolean;
  pwaRefresh: (() => Promise<void>) | null;
}

export const appStore = new Store<AppState>({
  ready: false,
  net: 'online',
  gpsStatus: 'idle',
  fix: null,
  gpsStale: true,
  search: { text: '', busy: false, results: [], degraded: false, searched: false },
  pickTarget: null,
  selected: null,
  origin: null,
  routeDest: null,
  planning: { busy: false, phase: '', done: 0, total: 0 },
  route: null,
  navActive: false,
  navSnap: null,
  arrived: false,
  camera: 'follow',
  threeD: true,
  panel: 'none',
  toasts: [],
  cache: { smartBytes: 0, permanentBytes: 0, pressure: 'ok', downloading: null },
  demo: new URLSearchParams(location.search).get('demo') === '1',
  pwaRefresh: null,
});

let toastSeq = 1;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const t = { id: toastSeq++, text, kind };
  appStore.set((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  setTimeout(() => {
    appStore.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
  }, kind === 'error' ? 9000 : 5000);
}

// ---- Navigation engine ------------------------------------------------------

const engine = new NavigationEngine({
  onRerouteNeeded: (origin) => {
    const { route } = appStore.get();
    if (!route) return;
    voice.rerouting();
    const dest = route.points[route.points.length - 1];
    void rerouteLocal(origin, dest).then((r) => {
      if (r.ok) {
        engine.setRoute(r.route);
        voice.reset();
        voice.speak('New route found.');
        appStore.set({ route: r.route, navSnap: null });
        cacheClient.pin(corridorKeysForRoute(r.route), `route-${r.route.createdAt}`);
        prefetchPredictive(true);
        toast('Rerouted using offline map data.', 'success');
      } else {
        toast(
          'Off route — rerouting needs cached road data here. Retrace toward the highlighted route; new data will be cached as you reconnect.',
          'warn',
        );
      }
    });
  },
  onArrived: () => {
    appStore.set({ arrived: true });
    toast('You have arrived.', 'success');
  },
});

// ---- Predictive caching -----------------------------------------------------

let lastPredictiveAt = 0;
let lastPredictiveAlong = -1;

function prefetchPredictive(force = false): void {
  const s = appStore.get();
  if (!s.route || !s.navActive || !s.fix) return;
  const st = settings.get();
  if (!st.predictive) return;
  const snap = s.navSnap;
  const along = snap?.alongM ?? 0;
  const now = Date.now();
  if (!force && (now - lastPredictiveAt < 15_000 || Math.abs(along - lastPredictiveAlong) < 1500)) return;
  lastPredictiveAt = now;
  lastPredictiveAlong = along;
  const speed = s.fix.speed ?? 14;
  const tiles = planPredictive(s.route.points, along, speed, {
    detailRadiusM: st.detailRadiusM,
  });
  if (tiles.length > 0) {
    cacheClient.prefetch(
      tiles.map((t) => `planet/${t.z}/${t.x}/${t.y}`),
      'predictive',
    );
  }
}

// ---- Eviction ---------------------------------------------------------------

let lastEvictAt = 0;

function requestEviction(force = false): void {
  const now = Date.now();
  if (!force && now - lastEvictAt < 60_000) return;
  lastEvictAt = now;
  const st = settings.get();
  const s = appStore.get();
  cacheClient.evict({
    budgetBytes: st.budgetMB * 1024 * 1024,
    autoCleanup: st.autoCleanup,
    nowMs: Date.now(),
    route: s.route && s.navActive ? s.route.points : null,
    posAlongM: s.navSnap?.alongM ?? null,
    corridorM: st.corridorM,
    keepBehindM: st.keepBehindM,
  });
}

async function refreshUsage(): Promise<void> {
  const u = await geostore.recomputeUsage();
  const ratio = u.smartBytes / Math.max(1, settings.get().budgetMB * 1024 * 1024);
  const pressure: Pressure = ratio > 1 ? 'critical' : ratio > 0.85 ? 'high' : 'ok';
  appStore.set((s) => ({ cache: { ...s.cache, smartBytes: u.smartBytes, permanentBytes: u.permanentBytes, pressure } }));
}

// ---- Cache events -----------------------------------------------------------

cacheClient.onEvent((e: CacheEvent) => {
  if (e.type === 'prefetch-progress') {
    appStore.set((s) => ({ planning: s.planning.busy ? s.planning : s.planning }));
  } else if (e.type === 'evicted') {
    void refreshUsage();
  } else if (e.type === 'cleared') {
    void refreshUsage();
    toast('Smart cache cleared. Permanent downloads were kept.', 'success');
  } else if (e.type === 'download-progress') {
    appStore.set((s) => ({
      cache: {
        ...s.cache,
        downloading: {
          id: e.areaId,
          name: s.cache.downloading?.id === e.areaId ? s.cache.downloading.name : e.areaId,
          done: e.done,
          total: e.total,
        },
      },
    }));
  } else if (e.type === 'download-done') {
    void refreshUsage();
    if (e.error) {
      appStore.set((s) => ({ cache: { ...s.cache, downloading: null, lastDownloadError: e.error } }));
      toast(e.error, 'error');
    } else {
      appStore.set((s) => ({ cache: { ...s.cache, downloading: null, lastDownloadError: undefined } }));
      toast('Offline area downloaded. It will never be auto-deleted.', 'success');
    }
  }
});

// ---- Subsystem wiring -------------------------------------------------------

let wired = false;

export async function initApp(): Promise<void> {
  if (wired) return;
  wired = true;

  await Promise.all([settings.init(), geostore.init()]);
  void refreshUsage();
  searchClient.refresh();

  // Network state → app store + UX transitions (never restarts navigation).
  net.store.subscribe(() => {
    const prev = appStore.get().net;
    const next = net.state;
    if (prev !== next) {
      appStore.set({ net: next });
      if (next === 'offline') {
        toast('Offline — navigation continues with your cached map data.', 'info');
      } else if (next === 'degraded') {
        toast('Connectivity problems — switching to cached data.', 'warn');
      } else if (prev === 'offline' || prev === 'degraded') {
        toast('Back online — refreshing cached data.', 'success');
        searchClient.refresh();
        requestEviction(true);
      }
    }
  });
  net.start();

  // GPS → app store + navigation engine + predictive cache.
  let gpsAnnounced = false;
  positioner.store.subscribe(() => {
    const g = positioner.store.get();
    appStore.set({
      fix: g.fix,
      gpsStatus: g.status,
      gpsMessage: g.message,
      gpsStale: g.stale,
    });
    // Announce GPS status once so the user knows what's happening.
    if (!gpsAnnounced && g.status !== 'idle' && g.status !== 'requesting') {
      gpsAnnounced = true;
      if (g.status === 'ok') {
        toast('GPS connected — your location is being tracked.', 'success');
      } else if (g.status === 'denied') {
        toast('Location permission denied. Enable it in browser settings for live navigation.', 'warn');
      } else if (g.status === 'unavailable') {
        toast('GPS not available on this device.', 'warn');
      }
    }
    if (g.fix && appStore.get().navActive) {
      const snap = engine.onFix(g.fix);
      appStore.set({ navSnap: snap });
      if (snap) {
        const { route } = appStore.get();
        if (route) voice.announce(route, snap);
      }
      prefetchPredictive();
    }
  });
  positioner.start();

  // Demo mode: only activate when ?demo=1 is in the URL.
  // This replaces real GPS with a simulated drive for testing.
  if (appStore.get().demo) {
    demoDrive.reset();
    positioner.setProvider(demoDrive);
  }

  // Dev/testing hook: lets external tooling (and the preview smoke tests)
  // reach the *real* app instance instead of a shadow module import.
  if (import.meta.env.DEV) {
    (window as unknown as { __wayline?: unknown }).__wayline = {
      appStore,
      planFromSelection,
      startNavigation,
      stopNavigation,
      rerouteLocal,
      planRoute,
      settings,
      router,
      /** Activate demo drive for testing (replaces real GPS). */
      startDemo() {
        demoDrive.reset();
        positioner.setProvider(demoDrive);
        appStore.set({ demo: true });
      },
    };
  }

  appStore.set({ ready: true });
}

// ---- Actions ----------------------------------------------------------------

export async function runSearch(text: string): Promise<void> {
  appStore.set((s) => ({ search: { ...s.search, text, busy: true } }));
  const { fix } = appStore.get();
  const center: [number, number] | undefined = fix ? [fix.lng, fix.lat] : undefined;
  const { results, degraded } = await searchClient.search(text, center, {
    geocodeOnline: settings.get().geocodeOnline,
    online: net.state === 'online',
  });
  appStore.set((s) => ({ search: { ...s.search, busy: false, results, degraded, searched: true } }));
}

export function selectResult(r: SearchResult): void {
  const { pickTarget } = appStore.get();
  if (pickTarget === 'origin') {
    appStore.set({ origin: r, panel: 'none', pickTarget: null });
  } else {
    appStore.set({ selected: r, panel: 'none', pickTarget: null });
  }
}

export function clearSelection(): void {
  appStore.set({ selected: null });
}

export function openSearchFor(pickTarget: 'dest' | 'origin'): void {
  appStore.set({ panel: 'search', pickTarget, search: { text: '', busy: false, results: [], degraded: false, searched: false } });
}

export async function planFromSelection(): Promise<void> {
  const s = appStore.get();
  const dest = s.selected;
  if (!dest) return;
  const originPt: [number, number] = s.origin
    ? [s.origin.lng, s.origin.lat]
    : s.fix
      ? [s.fix.lng, s.fix.lat]
      : [-76.88, 40.26]; // Harrisburg default — mapCenter is unreliable after map flies to dest
  appStore.set({
    routeDest: dest.name,
    origin: s.origin ?? null,
    planning: { busy: true, phase: 'coarse', done: 0, total: 0 },
    route: null,
    navSnap: null,
    arrived: false,
  });
  const r = await planRoute(originPt, [dest.lng, dest.lat], (p) => {
    appStore.set({ planning: { busy: true, phase: p.phase, done: p.done, total: p.total } });
  });
  if (r.ok) {
    appStore.set({ route: r.route, planning: { busy: false, phase: 'done', done: 1, total: 1 } });
    requestEviction();
  } else {
    appStore.set({ planning: { busy: false, phase: '', done: 0, total: 0, error: r.error } });
    toast(r.error, 'error');
  }
}

export function startNavigation(): void {
  const { route, gpsStatus } = appStore.get();
  if (!route) return;
  // If GPS is denied or unavailable, warn the user but still start
  // (they can still see the route and manual navigation info).
  if (gpsStatus === 'denied') {
    toast('Location permission is needed for live navigation. Grant it in your browser settings.', 'warn');
  } else if (gpsStatus === 'unavailable') {
    toast('GPS not available on this device. Navigation will show the route without live tracking.', 'warn');
  }
  engine.setRoute(route);
  voice.reset();
  appStore.set({ navActive: true, arrived: false, camera: 'follow', panel: 'none' });
  prefetchPredictive(true);
}

export function stopNavigation(): void {
  engine.stop();
  voice.reset();
  appStore.set({ navActive: false, navSnap: null, arrived: false, camera: 'free' });
  const { route } = appStore.get();
  if (route) cacheClient.unpin(`route-${route.createdAt}`);
}

export function clearRoute(): void {
  stopNavigation();
  appStore.set({ route: null, selected: null, origin: null, routeDest: null });
}

export function setCamera(mode: AppState['camera']): void {
  appStore.set({ camera: mode });
}

export function recenter(): void {
  appStore.set({ camera: 'follow' });
}

export function setThreeD(on: boolean): void {
  appStore.set({ threeD: on });
}

export function openPanel(panel: AppState['panel']): void {
  appStore.set({ panel });
  if (panel === 'settings') void refreshUsage();
}

let mapCenterRef: (() => [number, number] | null) | null = null;
let mapBoundsRef: (() => { minLng: number; minLat: number; maxLng: number; maxLat: number } | null) | null = null;
export function setMapCenterProvider(fn: () => [number, number] | null): void {
  mapCenterRef = fn;
}
export function setMapBoundsProvider(
  fn: () => { minLng: number; minLat: number; maxLng: number; maxLat: number } | null,
): void {
  mapBoundsRef = fn;
}
function mapCenter(): [number, number] | null {
  return mapCenterRef?.() ?? null;
}
export function mapBounds(): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  return mapBoundsRef?.() ?? null;
}

export async function clearSmartCache(): Promise<void> {
  cacheClient.clearSmart();
}

export async function downloadCurrentView(
  name: string,
  box: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  maxZoom: number,
): Promise<void> {
  const id = `area-${Date.now()}`;
  appStore.set((s) => ({ cache: { ...s.cache, downloading: { id, name, done: 0, total: 0 } } }));
  cacheClient.downloadArea({ id, name, box, maxZoom });
}

export async function deleteArea(id: string): Promise<void> {
  cacheClient.deleteArea(id);
  await refreshUsage();
}

export function setPwaRefresh(fn: () => Promise<void>): void {
  appStore.set({ pwaRefresh: fn });
}

export { tileProvider, geostore, settings };
