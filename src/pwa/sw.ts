/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string }[];
};

const SHELL = 'wayline-shell-v1';
const RUNTIME = 'wayline-mapdata-v1';
const RUNTIME_MAX = 1500;

const manifest = self.__WB_MANIFEST ?? [];

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.all(
        manifest.map((entry) => {
          const url =
            entry.revision && !entry.url.includes('__WB_REVISION__')
              ? `${entry.url}?__WB_REVISION__=${entry.revision}`
              : entry.url;
          return cache.add(new Request(url, { cache: 'reload' })).catch(() => {});
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL && key !== RUNTIME) await caches.delete(key);
      }
      await clientsClaim();
    })(),
  );
});

/** Map style JSON, glyphs and sprites — small, immutable-ish, essential offline. */
function isMapChrome(url: URL): boolean {
  return (
    url.hostname === 'tiles.openfreemap.org' &&
    (url.pathname.startsWith('/fonts/') ||
      url.pathname.startsWith('/styles/') ||
      url.pathname.startsWith('/sprites/'))
  );
}

async function trimRuntime(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  if (keys.length <= RUNTIME_MAX) return;
  // Evict oldest half (insertion order approximates LRU well enough here).
  const excess = keys.slice(0, keys.length - RUNTIME_MAX + 200);
  for (const k of excess) await cache.delete(k);
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  const url = new URL(req.url);

  // Navigations: network first, cached shell fallback (full offline restart).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(SHELL);
          const shell = await cache.match('/', { ignoreSearch: true });
          return (
            shell ??
            new Response('Offline and app shell not cached yet.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
          );
        }
      })(),
    );
    return;
  }

  // Map chrome (style/fonts/sprites): cache-first, then runtime cache.
  if (isMapChrome(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) {
            await cache.put(req, res.clone());
            void trimRuntime(cache);
          }
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      })(),
    );
    return;
  }

  // Everything else (including map tiles) passes through: map tiles are
  // managed by the app's Smart Offline Cache, never double-cached here.
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting();
});
