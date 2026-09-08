import type { ReactNode } from 'react';
import { appStore, openSearchFor, useStore } from '../app/state';

/**
 * Google Maps-style From → To toolbar shown on the map when no route is active.
 * Tapping "My location" or the destination opens the search panel to pick.
 */
export default function FromToPanel(): ReactNode {
  const s = useStore(appStore);
  if (s.navActive) return null;

  // Show GPS status in the origin field when no fix is available yet.
  const gpsUnavailable = !s.origin && !s.fix && (s.gpsStatus === 'denied' || s.gpsStatus === 'unavailable' || s.gpsStatus === 'error');
  const gpsLabel = !s.origin && !s.fix
    ? s.gpsStatus === 'requesting' ? 'Acquiring GPS…'
    : s.gpsStatus === 'denied' ? 'GPS denied — tap to set origin'
    : s.gpsStatus === 'unavailable' ? 'No GPS — tap to set origin'
    : 'Waiting for GPS…'
    : null;
  const originLabel = s.origin?.name ?? gpsLabel ?? 'My location';
  const destLabel = s.selected?.name ?? '';

  // Show the panel when the user has selected a destination or is actively
  // browsing (search panel closed, no route yet).
  const show = s.panel !== 'search' || s.selected;
  if (!show && !s.selected) {
    // Always show the toolbar — it's the primary entry point.
  }

  return (
    <div className="fromto-panel">
      <div className="fromto-dots">
        <div className="fromto-dot fromto-dot-origin" />
        <div className="fromto-line" />
        <div className="fromto-dot fromto-dot-dest" />
      </div>
      <div className="fromto-fields">
        <button
          className="fromto-field fromto-origin"
          onClick={() => openSearchFor('origin')}
        >
          <span className={`fromto-label${gpsLabel ? ' gps-waiting' : ''}`}>{originLabel}</span>
        </button>
        <button
          className="fromto-field fromto-dest"
          onClick={() => openSearchFor('dest')}
        >
          <span className="fromto-label">
            {destLabel || 'Enter destination'}
          </span>
        </button>
      </div>
      <div className="fromto-actions">
        <button
          className="fromto-swap"
          onClick={() => {
            const o = s.origin;
            const d = s.selected;
            appStore.set({ origin: d, selected: o });
          }}
          title="Swap origin and destination"
          aria-label="Swap origin and destination"
        >
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M7 16V4m0 12l-3-3m3 3l3-3M17 8v12m0-12l3 3m-3-3l-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
      </div>
      {gpsUnavailable && (
        <div className="gps-hint">
          GPS not available. Tap the map to set your location, or search for a starting point above.
        </div>
      )}
    </div>
  );
}
