import { useEffect, type ReactNode } from 'react';
import MapCanvas from './ui/MapCanvas';
import StatusBar from './ui/StatusBar';
import FromToPanel from './ui/FromToPanel';
import SearchPanel from './ui/SearchPanel';
import RouteSheet from './ui/RouteSheet';
import NavHud from './ui/NavHud';
import SettingsDrawer from './ui/SettingsDrawer';
import { DemoPanel, Toasts } from './ui/Overlays';
import { appStore, initApp, openPanel, recenter, useStore } from './app/state';

export default function App(): ReactNode {
  const s = useStore(appStore);

  useEffect(() => {
    void initApp();
  }, []);

  const showRecenter = s.camera !== 'follow' && s.fix;

  return (
    <div className="app">
      <MapCanvas />

      {/* Status bar: visible when not navigating */}
      {!s.navActive && <StatusBar />}

      {/* From/To panel: primary entry point when no route active */}
      {!s.navActive && !s.route && !s.planning.busy && <FromToPanel />}

      {/* Settings button: always accessible */}
      {!s.navActive && s.panel !== 'settings' && (
        <button
          className="settings-fab"
          onClick={() => openPanel('settings')}
          aria-label="Settings"
          title="Settings"
        >
          ☰
        </button>
      )}

      {/* Recenter button: visible when camera is not following GPS */}
      {showRecenter && (
        <button
          className="recenter-btn"
          onClick={recenter}
          aria-label="Recenter on GPS"
          title="Recenter on GPS"
        >
          <svg viewBox="0 0 24 24" width="22" height="22">
            <circle cx="12" cy="12" r="4" fill="currentColor" />
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </button>
      )}

      {/* Search panel: destination or origin search */}
      {s.panel === 'search' && <SearchPanel />}

      {/* Route sheet: destination preview / planning / route summary / arrival */}
      {(s.selected || s.route || s.planning.busy || s.arrived) && !s.navActive && <RouteSheet />}

      {/* Navigation HUD: active during navigation */}
      <NavHud />

      {/* Settings drawer */}
      <SettingsDrawer />

      {/* Toasts */}
      <Toasts />

      {/* Demo panel (only in ?demo=1 mode) */}
      <DemoPanel />
    </div>
  );
}
