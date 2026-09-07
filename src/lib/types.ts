import type { LngLat } from './geo';

export type ManeuverType =
  | 'depart'
  | 'turn'
  | 'continue'
  | 'merge'
  | 'roundabout'
  | 'arrive';

export type ManeuverModifier =
  | 'left'
  | 'right'
  | 'slight left'
  | 'slight right'
  | 'sharp left'
  | 'sharp right'
  | 'straight'
  | 'uturn';

export interface RouteStep {
  type: ManeuverType;
  modifier?: ManeuverModifier;
  /** Road name the maneuver leads onto (human phrasing uses this). */
  name: string;
  location: LngLat;
  /** Distance from this step's location to the next step. */
  distanceM: number;
  durationS: number;
  /** Cumulative distance from route start to this step location. */
  cumDistM: number;
  /** Cumulative duration from route start to this step location. */
  cumDurS: number;
  /** Index into route.points of this step's location. */
  pointIndex: number;
}

export interface Route {
  points: LngLat[];
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
  createdAt: number;
}

export type SearchResultSource = 'local' | 'online';

export interface SearchResult {
  id: string;
  name: string;
  /** Secondary line, e.g. city/state context. */
  detail?: string;
  lat: number;
  lng: number;
  source: SearchResultSource;
  kind?: string;
}

export interface CorridorProgress {
  /** Tiles requested vs completed for the current prefetch job. */
  done: number;
  total: number;
  phase: 'coarse' | 'corridor' | 'detail' | 'predictive' | 'download';
}
