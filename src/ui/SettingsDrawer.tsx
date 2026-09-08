import { useEffect, useState, type ReactNode } from 'react';
import {
  appStore,
  clearSmartCache,
  deleteArea,
  downloadCurrentView,
  mapBounds,
  openPanel,
  useStore,
} from '../app/state';
import { geostore } from '../lib/storage/geostore';
import { PRESETS, settings } from '../lib/settings';
import { formatBytes } from '../lib/format';
import type { AreaMeta } from '../lib/storage/db';

export default function SettingsDrawer(): ReactNode {
  const s = useStore(appStore);
  const st = settings.get();
  const [areas, setAreas] = useState<AreaMeta[]>([]);
  const [areaName, setAreaName] = useState('');
  const [maxZoom, setMaxZoom] = useState(13);
  const [deviceFree, setDeviceFree] = useState<number | null>(null);

  useEffect(() => {
    if (s.panel !== 'settings') return;
    void geostore.listAreas().then(setAreas);
    void navigator.storage?.estimate?.().then((e) => setDeviceFree(e.quota ?? null));
  }, [s.panel, s.cache.smartBytes, s.cache.permanentBytes]);

  if (s.panel !== 'settings') return null;
  const budgetBytes = st.budgetMB * 1024 * 1024;
  const smartPct = Math.min(100, (s.cache.smartBytes / budgetBytes) * 100);

  return (
    <div className="drawer-backdrop" onClick={() => openPanel('none')}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Offline Storage</h2>
          <button className="icon-btn" onClick={() => openPanel('none')}>
            ✕
          </button>
        </div>

        {/* Storage overview */}
        <section>
          <div className="storage-row">
            <span>Smart Cache</span>
            <b>{formatBytes(s.cache.smartBytes)}</b>
          </div>
          <div className="bar">
            <div className={`bar-fill ${s.cache.pressure === 'critical' ? 'red' : s.cache.pressure === 'high' ? 'amber' : ''}`} style={{ width: `${smartPct}%` }} />
          </div>
          <div className="storage-row">
            <span>Permanent Downloads</span>
            <b>{formatBytes(s.cache.permanentBytes)}</b>
          </div>
          <div className="storage-row subtle">
            <span>Total</span>
            <b>{formatBytes(s.cache.smartBytes + s.cache.permanentBytes)}</b>
          </div>
          {deviceFree != null && (
            <div className="storage-row subtle">
              <span>Browser storage available</span>
              <b>{formatBytes(deviceFree)}</b>
            </div>
          )}
          <button className="ghost full" onClick={() => void clearSmartCache()}>
            Clear Smart Cache (keeps permanent downloads)
          </button>
          <p className="hint">
            The smart cache automatically stores the roads around you and your route, and removes
            what you no longer need. Permanent downloads are never touched by cleanup.
          </p>
        </section>

        {/* Presets */}
        <section>
          <h3>Storage preset</h3>
          <div className="preset-row">
            {(['minimal', 'balanced', 'expanded'] as const).map((p) => (
              <button
                key={p}
                className={st.preset === p ? 'preset active' : 'preset'}
                onClick={() => settings.applyPreset(p)}
              >
                <b>{p[0].toUpperCase() + p.slice(1)}</b>
                <span>{PRESETS[p].budgetMB} MB</span>
              </button>
            ))}
          </div>
        </section>

        {/* Cache controls */}
        <section>
          <h3>Caching</h3>
          <label className="ctl">
            <span>Storage limit — {st.budgetMB} MB</span>
            <input
              type="range"
              min={50}
              max={4000}
              step={50}
              value={st.budgetMB}
              onChange={(e) => settings.update({ budgetMB: +e.target.value, preset: 'custom' })}
            />
          </label>
          <label className="ctl">
            <span>Cache radius around route — {(st.corridorM / 1000).toFixed(1)} km</span>
            <input
              type="range"
              min={500}
              max={10000}
              step={250}
              value={st.corridorM}
              onChange={(e) => settings.update({ corridorM: +e.target.value })}
            />
          </label>
          <label className="ctl">
            <span>Detail radius around you — {(st.detailRadiusM / 1000).toFixed(1)} km</span>
            <input
              type="range"
              min={500}
              max={8000}
              step={250}
              value={st.detailRadiusM}
              onChange={(e) => settings.update({ detailRadiusM: +e.target.value })}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={st.routeCaching}
              onChange={(e) => settings.update({ routeCaching: e.target.checked })}
            />
            <span>Route caching</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={st.predictive}
              onChange={(e) => settings.update({ predictive: e.target.checked })}
            />
            <span>Predictive caching ahead of you</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={st.autoCleanup}
              onChange={(e) => settings.update({ autoCleanup: e.target.checked })}
            />
            <span>Automatic cleanup</span>
          </label>
        </section>

        {/* Permanent downloads */}
        <section>
          <h3>Permanent offline areas</h3>
          <p className="hint">
            Download a whole area for guaranteed offline coverage — never auto-deleted.
          </p>
          <input
            className="text-input"
            placeholder="Area name (e.g. Home region)"
            value={areaName}
            onChange={(e) => setAreaName(e.target.value)}
          />
          <label className="ctl">
            <span>Detail level — up to z{maxZoom} {maxZoom >= 14 ? '(city detail)' : maxZoom >= 13 ? '(street level)' : '(major roads)'}</span>
            <input
              type="range"
              min={10}
              max={14}
              step={1}
              value={maxZoom}
              onChange={(e) => setMaxZoom(+e.target.value)}
            />
          </label>
          <button
            className="primary full"
            onClick={() => {
              const b = mapBounds();
              if (!b) return;
              void downloadCurrentView(areaName.trim() || `Area ${new Date().toLocaleDateString()}`, b, maxZoom);
            }}
            disabled={!!s.cache.downloading}
          >
            {s.cache.downloading
              ? `Downloading… ${s.cache.downloading.done}/${s.cache.downloading.total || '?'}`
              : 'Download current map view'}
          </button>
          {areas.length > 0 && (
            <div className="areas">
              {areas.map((a) => (
                <div key={a.id} className="area-row">
                  <div>
                    <b>{a.name}</b>
                    <span className="subtle">
                      {' '}
                      · {formatBytes(a.sizeBytes)} · {a.tileKeys.length} tiles · never auto-deleted
                    </span>
                  </div>
                  <button className="danger small" onClick={() => void deleteArea(a.id)}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Saved places */}
        <section>
          <h3>Saved places</h3>
          <p className="hint">
            Save frequently used locations for quick route planning.
          </p>
          <div className="saved-places-list">
            {st.savedPlaces.length === 0 && (
              <div className="hint">No saved places yet. Search for a location and long-press to save it.</div>
            )}
            {st.savedPlaces.map((p) => (
              <div key={p.id} className="saved-place-item">
                <span style={{ fontSize: '18px' }}>{p.label === 'Home' ? '🏠' : p.label === 'Work' ? '💼' : '📍'}</span>
                <div style={{ flex: 1 }}>
                  <div className="place-label">{p.label}</div>
                  {p.address && <div className="place-addr">{p.address}</div>}
                </div>
                <button
                  className="place-delete"
                  onClick={() => {
                    settings.update({
                      savedPlaces: st.savedPlaces.filter((x) => x.id !== p.id),
                    });
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            className="ghost full"
            style={{ marginTop: '8px' }}
            onClick={() => {
              const label = prompt('Label for this place (e.g. Home, Work, Gym):');
              if (!label) return;
              const fix = appStore.get().fix;
              if (!fix) {
                alert('GPS not available. Move to the location you want to save first.');
                return;
              }
              const newPlace = {
                id: `place-${Date.now()}`,
                label,
                lat: fix.lat,
                lng: fix.lng,
              };
              settings.update({ savedPlaces: [...st.savedPlaces, newPlace] });
            }}
          >
            Save current location
          </button>
        </section>

        {/* Units + privacy */}
        <section>
          <h3>Preferences</h3>
          <label className="ctl">
            <span>Units</span>
            <select
              value={st.units}
              onChange={(e) => settings.update({ units: e.target.value as 'metric' | 'imperial' })}
            >
              <option value="metric">Metric</option>
              <option value="imperial">Imperial</option>
            </select>
          </label>
          <label className="ctl">
            <span>Map theme</span>
            <select
              value={st.mapTheme}
              onChange={(e) => settings.update({ mapTheme: e.target.value as 'auto' | 'day' | 'night' })}
            >
              <option value="auto">Auto (day / night)</option>
              <option value="day">Day</option>
              <option value="night">Night</option>
            </select>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={st.voice}
              onChange={(e) => settings.update({ voice: e.target.checked })}
            />
            <span>Voice guidance (works offline)</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={st.geocodeOnline}
              onChange={(e) => settings.update({ geocodeOnline: e.target.checked })}
            />
            <span>Use online search when connected (query text only)</span>
          </label>
        </section>

        {/* About */}
        <section>
          <h3>About &amp; licenses</h3>
          <p className="hint">
            Map data © OpenStreetMap contributors (ODbL) · tiles by OpenFreeMap · routing &
            search run entirely on your device · geocoding by Photon · map rendering by MapLibre GL JS.
            Core offline navigation is free, forever — no accounts, no subscriptions.
          </p>
          {s.pwaRefresh && (
            <button className="ghost full" onClick={() => void s.pwaRefresh?.()}>
              Update app to the latest version
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
