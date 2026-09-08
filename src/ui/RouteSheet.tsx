import { appStore, clearRoute, clearSelection, enterRouteSetup, closeRouteSetup, swapRouteSetup, planRouteFromSetup, startNavigation, useStore } from '../app/state';
import { formatDistance, formatDuration, formatEta } from '../lib/format';

const PHASE_LABEL: Record<string, string> = {
  coarse: 'Downloading trip map data…',
  corridor: 'Caching the route corridor…',
  done: 'Ready',
};

export default function RouteSheet(): React.ReactNode {
  const s = useStore(appStore);

  // Destination picked, route not planned yet (Google Maps-style preview).
  if (s.selected && !s.routeSetup && !s.route && !s.planning.busy) {
    return (
      <div className="sheet route-sheet">
        <div className="route-title">{s.selected.name}</div>
        {s.selected.detail && <div className="route-sub">{s.selected.detail}</div>}
        <div className="row-buttons">
          <button className="ghost" onClick={clearSelection}>
            Close
          </button>
          <button className="primary" onClick={enterRouteSetup}>
            Directions
          </button>
        </div>
      </div>
    );
  }

  if (s.planning.busy) {
    const pct = s.planning.total > 0 ? Math.round((s.planning.done / s.planning.total) * 100) : 8;
    return (
      <div className="sheet route-sheet">
        <div className="route-title">Planning route…</div>
        <div className="bar">
          <div className="bar-fill" style={{ width: `${Math.max(8, pct)}%` }} />
        </div>
        <div className="route-sub">{PHASE_LABEL[s.planning.phase] ?? s.planning.phase}</div>
        <button className="ghost" onClick={() => appStore.set({ planning: { busy: false, phase: '', done: 0, total: 0 } })}>
          Cancel
        </button>
      </div>
    );
  }

  if (s.route) {
    const destName = s.routeDest ?? s.selected?.name ?? s.routeSetup?.dest?.name ?? 'Destination';
    return (
      <div className="sheet route-sheet">
        <div className="route-title">Route to {destName}</div>
        <div className="route-stats">
          <div>
            <b>{formatDuration(s.route.durationS)}</b>
            <span> · {formatDistance(s.route.distanceM, 'metric')} · ETA {formatEta(s.route.durationS)}</span>
          </div>
        </div>
        <div className="route-sub">
          Route corridor is being cached automatically — navigation keeps working offline on this route.
        </div>
        <div className="row-buttons">
          <button className="ghost" onClick={clearRoute}>
            Edit Route
          </button>
          <button className="primary" onClick={startNavigation}>
            Start navigation
          </button>
        </div>
      </div>
    );
  }

  // Route setup (From / To selection)
  if (s.routeSetup) {
    const fromName = s.routeSetup.origin === 'current' ? 'Your location' : s.routeSetup.origin?.name ?? 'Choose starting point';
    const toName = s.routeSetup.dest?.name ?? 'Choose destination';
    const canRoute = !!s.routeSetup.origin && !!s.routeSetup.dest;

    return (
      <div className="sheet route-sheet route-setup">
        <div className="route-setup-header" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '16px' }}>
          <button className="ghost icon-btn" onClick={closeRouteSetup} aria-label="Close" style={{ padding: '8px', marginTop: '4px' }}>
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          
          <div className="route-setup-fields" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', position: 'relative' }}>
            <div 
              className="field-row" 
              onClick={() => appStore.set({ panel: 'search', searchMode: 'origin' })}
              style={{ padding: '10px 12px', background: '#0e1726', borderRadius: '8px', border: '1px solid #263148', display: 'flex', alignItems: 'center', gap: '12px' }}
            >
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#60a5fa' }} />
              <div style={{ flex: 1, fontSize: '15px', color: s.routeSetup.origin === 'current' ? '#60a5fa' : s.routeSetup.origin ? '#fff' : '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fromName}</div>
            </div>
            
            <div style={{ position: 'absolute', left: '15px', top: '24px', bottom: '24px', width: '2px', background: '#31415f', zIndex: 0 }} />

            <div 
              className="field-row" 
              onClick={() => appStore.set({ panel: 'search', searchMode: 'dest' })}
              style={{ padding: '10px 12px', background: '#0e1726', borderRadius: '8px', border: '1px solid #263148', display: 'flex', alignItems: 'center', gap: '12px', zIndex: 1 }}
            >
              <div style={{ width: '8px', height: '8px', background: '#f87171' }} />
              <div style={{ flex: 1, fontSize: '15px', color: s.routeSetup.dest ? '#fff' : '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{toName}</div>
            </div>
          </div>

          <button className="ghost icon-btn swap-btn" onClick={swapRouteSetup} aria-label="Swap directions" style={{ padding: '8px', marginTop: '16px' }}>
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l-4-4m4 4l4-4"/></svg>
          </button>
        </div>
        <div className="row-buttons">
          <button className="primary" onClick={() => void planRouteFromSetup()} disabled={!canRoute}>
            Preview Route
          </button>
        </div>
      </div>
    );
  }

  return null;
}
