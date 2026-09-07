import type { ExpressionSpecification, FilterSpecification, StyleSpecification } from 'maplibre-gl';
import { TILE_PROTOCOL } from './tiles';

export type MapTheme = 'day' | 'night';
export type ThemeSetting = 'auto' | 'day' | 'night';

/** Resolve the user's theme preference (auto = local daytime 07:00–19:00). */
export function resolveTheme(pref: ThemeSetting, now = new Date()): MapTheme {
  if (pref === 'day' || pref === 'night') return pref;
  const h = now.getHours();
  return h >= 7 && h < 19 ? 'day' : 'night';
}

const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

interface Palette {
  bg: string;
  green: string;
  water: string;
  waterway: string;
  building: string;
  rail: string;
  residential: string;
  motorway: string;
  motorwayCase: string;
  trunk: string;
  trunkCase: string;
  primary: string;
  primaryCase: string;
  minor: string;
  minorCase: string;
  service: string;
  serviceCase: string;
  path: string;
  roadLabel: string;
  roadLabelHalo: string;
  place: string;
  placeHalo: string;
  poi: string;
  poiHalo: string;
  shieldTextMotorway: string;
  shieldCaseMotorway: string;
  shieldTextOther: string;
  shieldCaseOther: string;
}

const DAY: Palette = {
  bg: '#eef0f3',
  green: '#cdeab0',
  water: '#a8d3f0',
  waterway: '#a8d3f0',
  building: '#e3e1dc',
  rail: '#b6b2ab',
  residential: '#e9e7e1',
  motorway: '#f0955f',
  motorwayCase: '#d67c46',
  trunk: '#f3b76b',
  trunkCase: '#d89a4e',
  primary: '#ffffff',
  primaryCase: '#dedbd4',
  minor: '#ffffff',
  minorCase: '#e4e2dd',
  service: '#f6f5f2',
  serviceCase: '#e8e6e1',
  path: '#cfc9bf',
  roadLabel: '#5f6b7a',
  roadLabelHalo: '#ffffff',
  place: '#3d4451',
  placeHalo: '#ffffff',
  poi: '#6b7280',
  poiHalo: '#f4f3f0',
  shieldTextMotorway: '#ffffff',
  shieldCaseMotorway: '#54769b',
  shieldTextOther: '#4a5568',
  shieldCaseOther: '#ffffff',
};

const NIGHT: Palette = {
  bg: '#141b26',
  green: '#17281d',
  water: '#102438',
  waterway: '#102438',
  building: '#1d2634',
  rail: '#2a3342',
  residential: '#181f2b',
  motorway: '#a06a3f',
  motorwayCase: '#7a5230',
  trunk: '#8a6b45',
  trunkCase: '#6b5334',
  primary: '#4d586c',
  primaryCase: '#384252',
  minor: '#3a4353',
  minorCase: '#2f3746',
  service: '#333b4a',
  serviceCase: '#2a3140',
  path: '#3d4657',
  roadLabel: '#8fa0b8',
  roadLabelHalo: '#141b26',
  place: '#b9c3d4',
  placeHalo: '#141b26',
  poi: '#7d8ba1',
  poiHalo: '#141b26',
  shieldTextMotorway: '#ffffff',
  shieldCaseMotorway: '#3f628f',
  shieldTextOther: '#cfd8e6',
  shieldCaseOther: '#2c3547',
};

function widthExpr(): ExpressionSpecification {
  return [
    'interpolate',
    ['exponential', 1.6],
    ['zoom'],
    5, 0.5,
    8, 1.0,
    10, 1.6,
    12, 2.6,
    14, 4.5,
    16, 8.5,
    19, 16,
  ];
}

function scale(e: ExpressionSpecification, k: number): ExpressionSpecification {
  if (e[0] !== 'interpolate') return e;
  const out: unknown[] = ['interpolate', e[1], e[2]];
  for (let i = 3; i < e.length; i += 2) {
    out.push(e[i], (e[i + 1] as number) * k);
  }
  return out as unknown as ExpressionSpecification;
}

function serviceWidth(): ExpressionSpecification {
  return ['interpolate', ['exponential', 1.6], ['zoom'], 14, 1.0, 16, 2.2, 19, 6];
}

function pathWidth(): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 13, 0.6, 18, 2];
}

/**
 * Google Maps driving-mode-inspired vector style over our smartcache protocol.
 * Roads are colored by OpenMapTiles class; buildings render as extrusions
 * (3D whenever the camera is pitched). No sprite needed: shields are bold
 * text on a class-colored halo.
 */
export function buildDrivingStyle(theme: MapTheme): StyleSpecification {
  const p = theme === 'night' ? NIGHT : DAY;

  const minorW = scale(widthExpr(), 0.8);
  const primaryW = widthExpr();
  const motorwayW = scale(widthExpr(), 1.25);
  const trunkW = scale(widthExpr(), 1.1);

  const widthFor = (cls: 'minor' | 'service' | 'primary' | 'trunk' | 'motorway'): ExpressionSpecification =>
    cls === 'motorway' ? motorwayW
      : cls === 'trunk' ? trunkW
        : cls === 'primary' ? primaryW
          : cls === 'minor' ? minorW
            : serviceWidth();

  const casingFor = (cls: 'minor' | 'service' | 'primary' | 'trunk' | 'motorway'): ExpressionSpecification =>
    scale(widthFor(cls), 1.55);

  const layoutLine = { 'line-cap': 'round', 'line-join': 'round' } as const;

  const layers: StyleSpecification['layers'] = [
    { id: 'bg', type: 'background', paint: { 'background-color': p.bg } },

    // Land cover
    {
      id: 'land-residential',
      type: 'fill',
      source: 'planet',
      'source-layer': 'landuse',
      filter: ['==', ['get', 'class'], 'residential'],
      paint: { 'fill-color': p.residential, 'fill-opacity': 0.55 },
    },
    {
      id: 'land-green',
      type: 'fill',
      source: 'planet',
      'source-layer': 'park',
      paint: { 'fill-color': p.green, 'fill-opacity': theme === 'night' ? 0.75 : 0.85 },
    },
    {
      id: 'land-wood',
      type: 'fill',
      source: 'planet',
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'forest']]],
      paint: { 'fill-color': p.green, 'fill-opacity': theme === 'night' ? 0.6 : 0.7 },
    },

    // Water
    { id: 'water', type: 'fill', source: 'planet', 'source-layer': 'water', paint: { 'fill-color': p.water } },
    {
      id: 'waterway',
      type: 'line',
      source: 'planet',
      'source-layer': 'waterway',
      minzoom: 8,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': p.waterway,
        'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 0.5, 12, 1.4, 16, 4],
      },
    },

    // Buildings (extrude for 3D; flat-looking at pitch 0)
    {
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'planet',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': p.building,
        'fill-extrusion-base': 0,
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['literal', 6]],
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    },

    // Rail
    {
      id: 'rail',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'rail'],
      minzoom: 10,
      paint: { 'line-color': p.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1.8] },
    },

    // Casings (minor → major so major roads sit on top)
    {
      id: 'casing-service',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'service'],
      minzoom: 14,
      layout: layoutLine,
      paint: { 'line-color': p.serviceCase, 'line-width': casingFor('service') },
    },
    {
      id: 'casing-minor',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'minor'],
      minzoom: 12,
      layout: layoutLine,
      paint: { 'line-color': p.minorCase, 'line-width': casingFor('minor') },
    },
    {
      id: 'casing-primary',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary']]],
      minzoom: 9,
      layout: layoutLine,
      paint: { 'line-color': p.primaryCase, 'line-width': casingFor('primary') },
    },
    {
      id: 'casing-motorway',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
      minzoom: 5,
      layout: layoutLine,
      paint: { 'line-color': p.motorwayCase, 'line-width': casingFor('motorway') },
    },

    // Road fills (minor → major)
    {
      id: 'road-path',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'path'],
      minzoom: 13,
      paint: { 'line-color': p.path, 'line-width': pathWidth(), 'line-dasharray': [2, 2] },
    },
    {
      id: 'road-service',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'service'],
      minzoom: 14,
      layout: layoutLine,
      paint: { 'line-color': p.service, 'line-width': widthFor('service') },
    },
    {
      id: 'road-minor',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'minor'],
      minzoom: 12,
      layout: layoutLine,
      paint: { 'line-color': p.minor, 'line-width': widthFor('minor') },
    },
    {
      id: 'road-primary',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary']]],
      minzoom: 7,
      layout: layoutLine,
      paint: { 'line-color': p.primary, 'line-width': widthFor('primary') },
    },
    {
      id: 'road-trunk',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'trunk'],
      minzoom: 5,
      layout: layoutLine,
      paint: { 'line-color': p.trunk, 'line-width': widthFor('trunk') },
    },
    {
      id: 'road-motorway',
      type: 'line',
      source: 'planet',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'motorway'],
      minzoom: 5,
      layout: layoutLine,
      paint: { 'line-color': p.motorway, 'line-width': widthFor('motorway') },
    },

    // Street name labels
    {
      id: 'label-road',
      type: 'symbol',
      source: 'planet',
      'source-layer': 'transportation_name',
      minzoom: 13.5,
      filter: ['has', 'name'],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 13.5, 9, 16, 11.5, 19, 13],
        'text-letter-spacing': 0.15,
      },
      paint: { 'text-color': p.roadLabel, 'text-halo-color': p.roadLabelHalo, 'text-halo-width': 2.2 },
    },

    // Route-number shields (bold ref on a class-colored halo badge)
    {
      id: 'label-shield',
      type: 'symbol',
      source: 'planet',
      'source-layer': 'transportation_name',
      minzoom: 7,
      filter: [
        'all',
        ['has', 'ref'],
        ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false],
      ] as FilterSpecification,
      layout: {
        'text-field': ['get', 'ref'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 9.5,
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-color': ['case', ['==', ['get', 'class'], 'motorway'], p.shieldTextMotorway, p.shieldTextOther],
        'text-halo-color': ['case', ['==', ['get', 'class'], 'motorway'], p.shieldCaseMotorway, p.shieldCaseOther],
        'text-halo-width': 2.6,
      },
    },

    // Place labels
    placeLabel('place-city', ['==', ['get', 'class'], 'city'], 4, ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 15], p, theme),
    placeLabel('place-town', ['==', ['get', 'class'], 'town'], 7, ['interpolate', ['linear'], ['zoom'], 7, 10, 13, 13], p, theme),
    placeLabel(
      'place-sub',
      ['match', ['get', 'class'], ['village', 'suburb', 'neighbourhood', 'hamlet'], true, false],
      11,
      10.5,
      p,
      theme,
    ),

    // Major POIs (light touch, high zoom only)
    {
      id: 'label-poi',
      type: 'symbol',
      source: 'planet',
      'source-layer': 'poi',
      minzoom: 15,
      filter: ['all', ['has', 'name'], ['<=', ['get', 'rank'], 3]],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-max-width': 8,
      },
      paint: { 'text-color': p.poi, 'text-halo-color': p.poiHalo, 'text-halo-width': 1.8 },
    },
  ];

  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      planet: {
        type: 'vector',
        tiles: [`${TILE_PROTOCOL}://planet/{z}/{x}/{y}`],
        attribution: '© OpenStreetMap contributors © OpenFreeMap',
      },
    },
    layers,
  };
}

function placeLabel(
  id: string,
  filter: FilterSpecification,
  minzoom: number,
  size: ExpressionSpecification | number,
  p: Palette,
  theme: MapTheme,
): StyleSpecification['layers'][number] {
  return {
    id,
    type: 'symbol',
    source: 'planet',
    'source-layer': 'place',
    minzoom,
    filter,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': size,
      'text-letter-spacing': 0.08,
      'text-max-width': 7,
    },
    paint: {
      'text-color': p.place,
      'text-halo-color': p.placeHalo,
      'text-halo-width': theme === 'night' ? 1.6 : 2.2,
    },
  };
}
