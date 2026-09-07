import { useEffect, type ReactNode } from 'react';
import MapCanvas from './ui/MapCanvas';
import StatusBar from './ui/StatusBar';
import SearchPanel from './ui/SearchPanel';
import RouteSheet from './ui/RouteSheet';
import NavHud from './ui/NavHud';
import SettingsDrawer from './ui/SettingsDrawer';
import { DemoPanel, Toasts } from './ui/Overlays';
import { appStore, initApp, openPanel, useStore } from './app/state';

export default function App(): ReactNode {
  const s = useStore(appStore);

  useEffect(() => {
    void initApp();
  }, []);

  return (
    <div className="app">
      <MapCanvas />
      {!s.navActive && <StatusBar />}
      {!s.route && !s.planning.busy && !s.navActive && s.panel === 'none' && (
        <button className="gms-search-pill" onClick={() => openPanel('search')} aria-label="Search destination">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <line x1="15.5" y1="15.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          <span>Search here</span>
        </button>
      )}
      {s.panel === 'search' && <SearchPanel />}
      {(s.selected || s.route || s.planning.busy) && !s.navActive && <RouteSheet />}
      <NavHud />
      <SettingsDrawer />
      <Toasts />
      <DemoPanel />
    </div>
  );
}
