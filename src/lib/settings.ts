import { Store } from './store';
import { loadSetting, saveSetting } from './storage/db';

export type PresetId = 'minimal' | 'balanced' | 'expanded' | 'custom';
export type ManagedPreset = Exclude<PresetId, 'custom'>;
export type Units = 'metric' | 'imperial';
export type ThemeSetting = 'auto' | 'day' | 'night';

export interface Settings {
  preset: PresetId;
  /** Smart-cache storage budget in megabytes. */
  budgetMB: number;
  /** Half-width of the cached corridor around the active route (meters). */
  corridorM: number;
  /** High-detail (z14) radius kept around the user and maneuver points (meters). */
  detailRadiusM: number;
  /** How much detailed data to keep behind the user while navigating (meters). */
  keepBehindM: number;
  routeCaching: boolean;
  predictive: boolean;
  autoCleanup: boolean;
  /** When online, allow sending search query text to the hosted geocoder. */
  geocodeOnline: boolean;
  units: Units;
  /** Spoken turn-by-turn guidance. */
  voice: boolean;
  /** Map appearance: auto follows local daytime. */
  mapTheme: ThemeSetting;
}

export const PRESETS: Record<
  ManagedPreset,
  Omit<Settings, 'preset' | 'units' | 'geocodeOnline' | 'voice' | 'mapTheme'>
> = {
  minimal: {
    budgetMB: 150,
    corridorM: 1000,
    detailRadiusM: 1200,
    keepBehindM: 2000,
    routeCaching: true,
    predictive: true,
    autoCleanup: true,
  },
  balanced: {
    budgetMB: 500,
    corridorM: 2000,
    detailRadiusM: 2000,
    keepBehindM: 5000,
    routeCaching: true,
    predictive: true,
    autoCleanup: true,
  },
  expanded: {
    budgetMB: 2000,
    corridorM: 4000,
    detailRadiusM: 3500,
    keepBehindM: 8000,
    routeCaching: true,
    predictive: true,
    autoCleanup: true,
  },
};

export const DEFAULT_SETTINGS: Settings = {
  preset: 'balanced',
  ...PRESETS.balanced,
  geocodeOnline: true,
  units: 'metric',
  voice: true,
  mapTheme: 'auto',
};

const SETTINGS_KEY = 'settings';

class SettingsManager {
  readonly store = new Store<Settings>(DEFAULT_SETTINGS);
  private loaded = false;

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const saved = await loadSetting<Partial<Settings>>(SETTINGS_KEY);
      if (saved) this.store.set({ ...DEFAULT_SETTINGS, ...saved });
    } catch {
      // first run / storage unavailable — defaults are fine
    }
    this.loaded = true;
  }

  get(): Settings {
    return this.store.get();
  }

  update(patch: Partial<Settings>): void {
    this.store.set(patch);
    void saveSetting(SETTINGS_KEY, this.store.get());
  }

  applyPreset(id: ManagedPreset): void {
    this.update({ preset: id, ...PRESETS[id] });
  }
}

export const settings = new SettingsManager();
