# Wayline — Offline-First GPS Navigation PWA

Wayline is an installable, offline-first GPS navigation app. Its core promise:
**you never need to download a whole city or state to navigate offline.** A
Smart Offline Cache automatically keeps the small, relevant slice of map and
routing data you actually need — your route, its corridor, your surroundings,
and what's coming next — and evicts the rest.

Basic offline navigation is and always will be **free**: no accounts, no
subscriptions, no artificial limits. Location stays on your device.

## Quick start

```bash
npm install
npm run icons      # generate PWA icons (pngjs, no native deps)
npm run dev        # dev server
npm test           # unit tests (vitest)
npm run build      # production build + service worker
npm run preview    # serve the production build
```

Open in a browser, allow location, search a destination, press **Route**, then
**Start**. Add `?demo=1` to the URL to simulate a GPS drive without moving
(includes a "leave road" toggle that exercises offline rerouting).

Install it via your browser's "Install app" prompt to run it as a PWA.

## How it behaves

- **Online** — map tiles stream from OpenFreeMap and are transparently written
  into the local cache as you view them; routes are computed **locally** in a
  Web Worker from the same cached tiles (the network is never used to route).
- **Smart Offline** — while you navigate, the app keeps a rolling cache: the
  route corridor, upcoming tiles, and your surroundings, within a configurable
  storage budget. Old areas are evicted automatically.
- **Fully Offline** — lose connectivity mid-trip and nothing stops: cached map,
  GPS, turn-by-turn, deviation detection, and **local rerouting** all continue.
  The status chip shows "Offline — using cached data"; no manual mode switch.

If you pick a destination whose area isn't on the device and you're offline,
the app says so honestly rather than pretending — that's a physical limit of
offline navigation, and the Smart Cache exists to make it rare.

## Feature map

| Area | Where |
| --- | --- |
| Map rendering (MapLibre, custom `smartcache://` tile protocol) | `src/ui/MapCanvas.tsx`, `src/lib/cache/tileProvider.ts` |
| Smart Offline Cache (budget, corridor, eviction, prefetch) | `src/lib/cache/*` |
| Local routing (A* over a graph built from cached vector tiles) | `src/lib/routing/*`, runs in `routerWorker.ts` |
| Offline search (local index over cached tiles, Photon online fallback) | `src/lib/search/*` |
| GPS + navigation engine (progress, deviation, reroute) | `src/lib/gps.ts`, `src/lib/navigation/engine.ts` |
| Storage layers (IndexedDB metadata, Cache Storage assets) | `src/lib/storage/*` |
| Storage management UI (budget, presets, permanent downloads) | `src/ui/SettingsDrawer.tsx` |
| Service worker (app shell + runtime strategies) | `src/pwa/sw.ts` |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, [TESTING.md](TESTING.md)
for the acceptance-test matrix, and [LICENSING.md](LICENSING.md) for
attribution and license obligations.

## Privacy

Route calculation, search over cached data, and map display all happen on the
device. The only outbound requests are anonymous map tile fetches (OpenFreeMap)
and, when online, geocoding queries (Photon) for places not yet in your local
index. No analytics, no accounts, no location leaves the device for routing.

## Data attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors, ODbL. Tiles by [OpenFreeMap](https://openfreemap.org/).
Geocoding by [Photon](https://photon.komoot.io/) by Komoot. Details and full
obligations in [LICENSING.md](LICENSING.md).
