# Licensing & Attribution

Verified as of September 2026. Re-verify before any commercial
redistribution of data.

## Map data — OpenStreetMap (ODbL)

- Source: © OpenStreetMap contributors, licensed under the **Open Database
  License (ODbL)** — https://www.openstreetmap.org/copyright
- **Obligation:** visible attribution ("© OpenStreetMap contributors"), and if
  a "substantially derived database" is distributed (e.g., packaged offline
  tile extracts), the derivative database must also be ODbL and shared.
  Wayline fetches tiles at runtime rather than redistributing an extracted
  database; if permanent downloads are ever bundled into a distribution,
  ODbL share-alike applies to that dataset.
- Attribution is rendered on the map (attribution control) and below.

## Map tiles — OpenFreeMap

- https://openfreemap.org/ — free hosted vector tiles built from OSM data,
  **no API key, no usage-based billing**, funded publicly.
- OpenFreeMap requires that OSM attribution remains visible. No additional
  tile-level restrictions; their public TileJSON/styles are used unmodified.
- Their hosting means Wayline ships no tile server; if self-hosting tiles
  later (e.g., planetiler output), ODbL obligations above apply directly.

## Map style / schema — OpenMapTiles

- The tile schema (layers like `transportation`, `transportation_name`,
  `building`, `place`) is **OpenMapTiles** (BSD-style license, usable in
  commercial products; attribution kept).
- The default style is based on OpenFreeMap's MIT-licensed styles.

## Rendering — MapLibre GL JS

- **BSD-3-Clause**. Commercial use permitted, license text must accompany
  distributions (`node_modules/maplibre-gl/LICENSE.txt` in source form;
  include in any app-store bundle).

## Geocoding — Photon by Komoot

- Server: **Apache-2.0**; the public endpoint `photon.komoot.io` is offered
  free with fair-use expectations. Used only for *online* search fallback;
  offline search is entirely local over cached data.
- If Wayline is commercialized at scale, run your own Photon instance (it is
  open source + OSM data) rather than relying on Komoot's public service.

## Toolchain

- React (MIT), Vite (MIT), vite-plugin-pwa (MIT), TypeScript (Apache-2.0),
  Vitest (MIT), pngjs (MIT, icon generation), pmtiles/protomaps MVT decoding
  is implemented in-house (no third-party decoder dependency).

## Attribution displayed in-app

Map footer shows: "© OpenStreetMap contributors © OpenFreeMap".
Keep this visible in every surface that shows map data, including the
installed PWA.

## Summary of obligations for shipping

1. Keep OSM + OpenFreeMap attribution visible. (Done — map control.)
2. Distribute MapLibre's BSD license text with the app. (Include in release.)
3. Do not resell or relicense OSM-derived data as proprietary; runtime tile
   caching (this repo's model) is standard compliant usage.
4. No location data leaves the device for routing; Photon receives only
   explicit search queries while online (documented in the privacy section).
