# Architecture

Priorities, in order: **Reliability → Offline capability → Storage efficiency →
Performance → Privacy → UX → Optional online features.**

## The one design decision that matters

There is no server-side routing. All routing — initial route, reroute, every
recalculation — is computed **on-device** by A* over a road graph built from the
same OpenMapTiles vector tiles the map renders. The network's only job is
fetching tiles and (when online) geocoding. This makes "online" and "offline"
the same code path: the router always reads local data; only the tile-fetch
backing store differs.

### Why not a routing engine (Valhalla / OSRM / GraphHopper WASM)?

Evaluated against: browser compatibility, WASM maturity, memory footprint,
graph size, speed, regional datasets, offline operation, license, and
commercial terms.

| Candidate | Verdict |
| --- | --- |
| **OSRM** | No supported browser/WASM build; server-oriented; demo server is online-only. |
| **Valhalla** | Tiles are large (full regions), no production browser WASM build; `valhalla-wasm`/ferrostar efforts are mobile-first and still need pre-built graphs — i.e., big downloads, the thing this product must avoid. |
| **GraphHopper** | Java; browser WASM is experimental/heavy; server-oriented. |
| **Custom A* over cached MVT tiles** ✅ | Zero extra downloads (reuses the exact bytes the map renders), tiny memory footprint (graph built lazily per tile set), instant offline, MIT/BSD-grade licensing, ~1s routes on real data. |

The routing needs of this app (road graph of a route corridor, not a
continents-wide contraction hierarchy) are well within what a plain A* in a
Web Worker handles — so the smallest practical architecture wins.

## Stack

- **React + TypeScript + Vite**, PWA via `vite-plugin-pwa` (injectManifest; we
  own `src/pwa/sw.ts`).
- **MapLibre GL JS** for rendering, fed through a custom `smartcache://`
  protocol so *every* tile the map shows passes through the Smart Cache.
- **IndexedDB** (`src/lib/storage/db.ts`) for tiles, metadata, search index,
  saved places, settings. **Cache Storage** for the app shell (service worker).
- **Web Workers**: `routerWorker.ts` (graph build + A*), `cacheWorker.ts`
  (prefetch, eviction, indexing, downloads), `searchWorker.ts` (indexing +
  queries). The UI thread never parses tiles or routes.

## Smart Offline Cache

`src/lib/cache/`:

- **tileProvider.ts** — single source of tiles: check cache → serve; miss →
  fetch from OpenFreeMap, store, serve. Zero-byte bodies are rejected
  (protects against previously-poisoned caches).
- **corridor.ts** — given a route polyline, selects the tiles within a
  configurable corridor radius (great-circle point–segment distance, not
  bbox), prioritized by distance along the route.
- **budget.ts** — storage presets (Minimal / Balanced / Expanded default
  budgets), usage accounting, and eviction scoring: active route tiles are
  pinned and never evicted; everything else scores by distance from position,
  route membership, and last-access time.
- **cacheWorker.ts** — orchestrates corridor prefetch ahead of the vehicle
  (predictive caching), background eviction under budget pressure, search
  index extraction from newly cached tiles, and permanent (pinned) downloads
  that cleanup never touches.

## Routing pipeline

1. `tile-graph.ts` builds a routing graph from decoded MVT
   `transportation` layers. Nodes exist at **every quantized path vertex**
   (planetiler merges ways across intersections, so endpoints alone miss
   junctions). Speeds come from an OpenMapTiles class table (`minor` =
   residential included).
2. `stitch.ts` repairs tile borders: planetiler buffers clipped ways ~15–20 m
   past the edge, so adjacent tiles' copies of a road *overlap without sharing
   vertices*. Dead-end nodes are snapped onto nearby edges of the adjacent
   tile and the edge is split — restoring cross-tile connectivity.
3. `astar.ts` runs A* with haversine heuristic over the worker-local graph.
4. `directions.ts` converts the edge path into turn-by-turn maneuvers
   (bearings → left/right/uturn…, street names joined from the
   `transportation_name` layer), suppressing noise steps <40 m and redundant
   straight continues.
5. `snap.ts` maps raw GPS to the graph, preferring major roads.
6. `planner.ts` is the front door: ensures corridor tiles exist (fetching
   them online when available, failing with a clear message when not), then
   routes — always locally.

## Navigation engine

`src/lib/navigation/engine.ts` consumes GPS fixes and route state:
project-on-route progress, remaining distance/time/ETA, off-route deviation
(distance threshold + heading check), triggering local replanning through
`planner.ts`. Deviation → local reroute requires **zero** network calls;
when local tiles can't support it, the UI states the limitation plainly.

## Network state

`src/lib/net.ts` combines `navigator.onLine` with a real reachability probe
against the tile endpoint, because a captive portal reports "online" while
being useless. Transitions never restart the navigation session.

## Search

Tiles already on the device are mined for searchable entities (streets, cities,
POIs — `src/lib/search/extract.ts`) into an IndexedDB-backed index queried from
`searchWorker.ts`. Online, results merge with Photon geocoding; offline, the
local index answers alone — never "internet required" for data we have.

## Demo mode

`?demo=1` replaces the GPS source with a simulator that drives the planned
route (with an optional off-route toggle), so offline behavior — deviation,
reroute, predictive caching — is testable from a desk.

## Deliberate limitations

Offline navigation requires the device to hold the relevant data. Wayline
never pretends otherwise: destinations outside cached coverage are reported
honestly, and the corridor + predictive systems exist to keep the required
dataset small, relevant, and automatically maintained.
