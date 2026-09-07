# Testing

## Automated tests

`npm test` (vitest) — 28 tests across 5 files, no browser required:

- **routing.test.ts** — graph building from synthetic MVT tiles (fixture
  encodes merged ways that cross without shared endpoints, matching real
  planetiler output), A* pathfinding, oneway restrictions, speed/class table.
- **cache.test.ts** — corridor tile selection (true point–segment distance,
  not bbox), budget accounting, eviction priority (pinned route tiles
  survive), predictive ordering.
- **navigation.test.ts** — route progress projection, deviation detection,
  reroute triggers.
- **search.test.ts** — entity extraction from tile layers (streets, cities,
  POIs), index queries, offline fallback behavior.
- **storage.test.ts** — IndexedDB schema, tile round-trip, permanent vs
  smart-cache separation.

## Acceptance matrix (manual)

The app is not claimed "offline navigation capable" beyond what was verified
below. Live verification is easiest with `?demo=1` and browser devtools
"Offline" throttling; a real device should disable Wi-Fi + cellular.

| # | Scenario | Status / How to verify |
| --- | --- | --- |
| 1 | Normal online navigation | ✅ Verified live in dev: search (Photon results), select, Route → 26.5 km route planned locally, Start, map+GPS normal. |
| 2 | Internet disappears mid-navigation | ✅ Verified live: devtools Offline during demo drive — map, GPS, turn banner and ETA continue; status chip switches to offline. Reroute toast confirms local data path. |
| 3 | Offline rerouting | ✅ Verified live: demo "Leave road" toggle → deviation detected → "Rerouting…" → "Rerouted using offline map data." — all local (no network in devtools). Unit tests cover engine triggers. |
| 4 | Limited storage | Unit-tested: budget respected, eviction removes lowest-score tiles first, pinned route tiles preserved. Manual: set Minimal preset + 100 MB limit in Settings, drive a route, watch usage stay under budget with warnings surfaced. |
| 5 | Long-distance trip | Route-aware corridor caching unit-tested (corridor ≪ city-wide tile set; only upcoming tiles prefetch). Manual: plan Harrisburg→NYC, observe corridor tiles count vs city area, progressive prefetch ahead, eviction behind. |
| 6 | Application restart | Tiles + index live in IndexedDB; service worker precaches the app shell. Manual: cache tiles, close, Offline, reopen — map renders and local search works (sw.js serves shell, IndexedDB serves tiles). |
| 7 | No manual download | ✅ Verified live: entire flow (search→route→navigate→offline) with zero manual downloads; corridor caching is automatic. |
| 8 | Permanent download | Unit-tested separation: "Clear Smart Cache" deletes only tier `smart` rows; permanent (pinned) areas untouched. Manual: Storage UI → download an area, go offline, verify, clear smart cache, re-verify. |

## Performance notes (measured, live)

- Graph build from a 3×3 z13 tile patch: ~5,400→36,000 edges/nodes, <1 s in
  worker.
- Local route Harrisburg→Hershey: 26.5 km in ~1.7 s fully on-device.
- Tile decode (721 road features): sub-second per tile.

## Manual offline checklist

```text
1. npm run build && npm run preview   (or install the PWA)
2. Load a route online; let tiles cache.
3. DevTools → Network → Offline.
4. Drive (or use ?demo=1 with "Leave road").
   ✓ Map renders from smartcache:// protocol
   ✓ GPS puck continues (real GPS needs no network)
   ✓ Maneuver banner + ETA update
   ✓ Deviation → local reroute
   ✓ Search still finds cached places
5. Reload while offline → app shell + cached tiles persist.
```
