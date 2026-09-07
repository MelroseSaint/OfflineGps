import { useEffect, useRef, type ReactNode } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { TILE_PROTOCOL } from '../lib/tiles';
import { tileProvider } from '../lib/cache/tileProvider';
import { buildDrivingStyle, resolveTheme } from '../lib/mapstyle';
import { settings } from '../lib/settings';
import { appStore, setMapBoundsProvider, setMapCenterProvider, useStore } from '../app/state';
import type { AppState } from '../app/state';
import type { Route } from '../lib/types';
import type { FeatureCollection } from 'geojson';
import { pathLengthM, type LngLat } from '../lib/geo';

let protocolInstalled = false;
function installProtocol(): void {
  if (protocolInstalled) return;
  protocolInstalled = true;
  maplibregl.addProtocol(TILE_PROTOCOL, async (params) => {
    // smartcache://planet/z/x/y
    console.debug('[smartcache] tile request', params.url);
    const key = params.url.replace(`${TILE_PROTOCOL}://`, '');
    const data = await tileProvider.obtain(key);
    if (!data) throw new Error(`tile unavailable: ${key}`);
    return { data };
  });
}

function routeGeoJSON(route: Route | null): FeatureCollection {
  if (!route) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: route.points },
      },
    ],
  };
}

function traveledGeoJSON(route: Route | null, alongM: number | null): FeatureCollection {
  if (!route || alongM == null) return { type: 'FeatureCollection', features: [] };
  const out: LngLat[] = [route.points[0]];
  let acc = 0;
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1];
    const b = route.points[i];
    const R = 6371008.8;
    const dLat = (b[1] - a[1]) * (Math.PI / 180);
    const dLng = (b[0] - a[0]) * (Math.PI / 180) * Math.cos((a[1] * Math.PI) / 180);
    const seg = Math.sqrt(dLat * dLat + dLng * dLng) * R;
    if (acc + seg >= alongM) {
      const t = seg === 0 ? 0 : (alongM - acc) / seg;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      break;
    }
    out.push(b);
    acc += seg;
  }
  if (out.length < 2) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: out } }],
  };
}

function circleGeoJSON(lng: number, lat: number, radiusM: number): FeatureCollection {
  if (!radiusM || radiusM <= 0) return { type: 'FeatureCollection', features: [] };
  const pts: LngLat[] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  for (let a = 0; a < 360; a += 15) {
    const r = (a * Math.PI) / 180;
    pts.push([lng + dLng * Math.cos(r), lat + dLat * Math.sin(r)]);
  }
  pts.push(pts[0]);
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } }],
  };
}

function maneuverGeoJSON(route: Route | null, stepIdx: number | null): FeatureCollection {
  if (!route || stepIdx == null || !route.steps[stepIdx]) return { type: 'FeatureCollection', features: [] };
  const s = route.steps[stepIdx];
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: s.location } }],
  };
}

function destGeoJSON(route: Route | null): FeatureCollection {
  if (!route) return { type: 'FeatureCollection', features: [] };
  const p = route.points[route.points.length - 1];
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }],
  };
}

function applyAll(map: maplibregl.Map, st: AppState): void {
  const set = (id: string, data: FeatureCollection): void => {
    const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
  };
  set('route', routeGeoJSON(st.route));
  set('traveled', traveledGeoJSON(st.route, st.navActive ? (st.navSnap?.alongM ?? null) : null));
  const fix = st.fix;
  set('accuracy', fix ? circleGeoJSON(fix.lng, fix.lat, Math.min(fix.accuracy, 300)) : circleGeoJSON(0, 0, 0));
  const idx = st.navActive && st.navSnap ? st.navSnap.nextStepIndex : null;
  set('maneuver', maneuverGeoJSON(st.route, idx));
  set('dest', destGeoJSON(st.route));
}

/** Add the navigation data sources + layers. Idempotent; re-runs after theme switches. */
function addNavLayers(map: maplibregl.Map, latest: AppState | null): void {
  if (map.getSource('route')) return;
  map.addSource('route', { type: 'geojson', data: routeGeoJSON(latest?.route ?? null) });
  map.addSource('traveled', { type: 'geojson', data: traveledGeoJSON(null, null) });
  map.addSource('accuracy', { type: 'geojson', data: circleGeoJSON(0, 0, 0) });
  map.addSource('maneuver', { type: 'geojson', data: maneuverGeoJSON(null, null) });
  map.addSource('dest', { type: 'geojson', data: destGeoJSON(null) });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 13 },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1a73e8', 'line-width': 9 },
  });
  map.addLayer({
    id: 'traveled-line',
    type: 'line',
    source: 'traveled',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#96a3b5', 'line-width': 9 },
  });
  map.addLayer({
    id: 'accuracy-fill',
    type: 'fill',
    source: 'accuracy',
    paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 },
  });
  map.addLayer({
    id: 'accuracy-line',
    type: 'line',
    source: 'accuracy',
    paint: { 'line-color': '#3b82f6', 'line-width': 1, 'line-opacity': 0.4 },
  });
  map.addLayer({
    id: 'maneuver-dot',
    type: 'circle',
    source: 'maneuver',
    paint: {
      'circle-radius': 6,
      'circle-color': '#1a73e8',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
    },
  });
  map.addLayer({
    id: 'dest-pin',
    type: 'circle',
    source: 'dest',
    paint: {
      'circle-radius': 8,
      'circle-color': '#ea4335',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
    },
  });
  if (latest) applyAll(map, latest);
}

export default function MapCanvas(): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const puckRef = useRef<maplibregl.Marker | null>(null);
  const state = useStore(appStore);
  const s: AppState = state;

  // Latest state for deferred application once the style finishes loading.
  const latestRef = useRef<AppState | null>(null);
  latestRef.current = s;

  // Init map once.
  useEffect(() => {
    installProtocol();
    let map: maplibregl.Map | null = null;
    let cancelled = false;

    (async () => {
      if (cancelled || !containerRef.current) return;
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildDrivingStyle(resolveTheme(settings.get().mapTheme)),
        center: [-76.88, 40.26],
        zoom: 12,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      // Debug handle (also used by the preview smoke tests).
      (window as unknown as { __waylineMap?: maplibregl.Map }).__waylineMap = map;
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left');

      map.on('load', () => {
        addNavLayers(map!, latestRef.current);
      });
      // After a theme switch the style is replaced — re-install our layers.
      map.on('styledata', () => {
        if (!map!.getSource('route')) addNavLayers(map!, latestRef.current);
      });

      map.on('dragstart', () => {
        if (appStore.get().camera === 'follow') appStore.set({ camera: 'free' });
      });

      setMapCenterProvider(() => {
        const c = map?.getCenter();
        return c ? [c.lng, c.lat] : null;
      });
      setMapBoundsProvider(() => {
        const b = map?.getBounds();
        return b
          ? { minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() }
          : null;
      });
    })();

    return () => {
      cancelled = true;
      setMapCenterProvider(() => null);
      setMapBoundsProvider(() => null);
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Theme setting (day/night/auto) — rebuild the style when it changes.
  const stg = useStore(settings.store);
  const themeRef = useRef(resolveTheme(settings.get().mapTheme));
  useEffect(() => {
    const theme = resolveTheme(stg.mapTheme);
    const map = mapRef.current;
    if (!map || theme === themeRef.current) return;
    themeRef.current = theme;
    map.setStyle(buildDrivingStyle(theme));
  }, [stg.mapTheme]);

  // 3D toggle — pitch the camera without waiting for the next GPS fix.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || s.camera !== 'follow') return;
    map.easeTo({ pitch: s.threeD ? (s.navActive ? 50 : 55) : 0, duration: 600 });
  }, [s.threeD, s.navActive, s.camera]);

  // Route geometry (deferred until the style is ready; also applied on load).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (map.getSource('route') as maplibregl.GeoJSONSource | undefined)?.setData(routeGeoJSON(s.route));
  }, [s.route]);

  // Traveled portion.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (map.getSource('traveled') as maplibregl.GeoJSONSource | undefined)?.setData(
      traveledGeoJSON(s.route, s.navActive ? (s.navSnap?.alongM ?? null) : null),
    );
  }, [s.route, s.navSnap, s.navActive]);

  // Location + accuracy + follow camera.
  useEffect(() => {
    const map = mapRef.current;
    const fix = s.fix;
    if (!map) return;
    if (map.isStyleLoaded()) {
      (map.getSource('accuracy') as maplibregl.GeoJSONSource | undefined)?.setData(
        fix ? circleGeoJSON(fix.lng, fix.lat, Math.min(fix.accuracy, 300)) : circleGeoJSON(0, 0, 0),
      );
    }
    if (!puckRef.current) {
      const el = document.createElement('div');
      el.className = 'puck';
      el.innerHTML = '<div class="puck-arrow"></div><div class="puck-dot"></div>';
      puckRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
        .setLngLat([fix?.lng ?? 0, fix?.lat ?? 0])
        .addTo(map);
    } else if (fix) {
      puckRef.current.setLngLat([fix.lng, fix.lat]);
      if (fix.heading != null) puckRef.current.setRotation(fix.heading);
    }
    if (fix && s.camera === 'follow') {
      map.easeTo({
        center: [fix.lng, fix.lat],
        bearing: fix.heading ?? (map.getBearing() as number),
        pitch: s.threeD ? (s.navActive ? 50 : 55) : 0,
        zoom: s.navActive ? 16.5 : 14.5,
        duration: 700,
        easing: (t) => t,
      });
    }
  }, [s.fix, s.camera, s.navActive, s.threeD]);

  // Next maneuver marker.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const idx = s.navActive && s.navSnap ? s.navSnap.nextStepIndex : null;
    (map.getSource('maneuver') as maplibregl.GeoJSONSource | undefined)?.setData(
      maneuverGeoJSON(s.route, idx),
    );
  }, [s.route, s.navSnap, s.navActive]);

  // Periodic reconciliation for updates that raced style loading.
  useEffect(() => {
    const iv = setInterval(() => {
      const map = mapRef.current;
      if (map && map.isStyleLoaded() && latestRef.current) applyAll(map, latestRef.current);
    }, 2500);
    return () => clearInterval(iv);
  }, []);

  // Camera modes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || s.camera !== 'overview' || !s.route) return;
    const pts = s.route.points;
    const lats = pts.map((p) => p[1]);
    const lngs = pts.map((p) => p[0]);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 70, duration: 800, pitch: s.threeD ? 45 : 0 },
    );
  }, [s.camera, s.route, s.threeD]);

  // Fly to selected search result.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !s.selected) return;
    map.easeTo({ center: [s.selected.lng, s.selected.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 900 });
  }, [s.selected]);

  return <div className="map-canvas" ref={containerRef} aria-label="Map" />;
}

export function routeLength(route: Route | null): number {
  return route ? pathLengthM(route.points) : 0;
}
