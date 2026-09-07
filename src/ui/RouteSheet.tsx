import { appStore, clearRoute, planFromSelection, startNavigation, useStore } from '../app/state';
import { formatDistance, formatDuration, formatEta } from '../lib/format';

const PHASE_LABEL: Record<string, string> = {
  coarse: 'Downloading trip map data…',
  corridor: 'Caching the route corridor…',
  done: 'Ready',
};

export default function RouteSheet(): React.ReactNode {
  const s = useStore(appStore);

  // Destination picked, route not planned yet (Google Maps-style preview).
  if (s.selected && !s.route && !s.planning.busy) {
    return (
      <div className="sheet route-sheet">
        <div className="route-title">{s.selected.name}</div>
        {s.selected.detail && <div className="route-sub">{s.selected.detail}</div>}
        <div className="row-buttons">
          <button className="ghost" onClick={clearRoute}>
            Close
          </button>
          <button className="primary" onClick={() => void planFromSelection()}>
            Route from here
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
        <button className="ghost" onClick={clearRoute}>
          Cancel
        </button>
      </div>
    );
  }

  if (!s.route) return null;
  const destName = s.routeDest ?? s.selected?.name ?? 'Destination';

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
          Dismiss
        </button>
        <button className="primary" onClick={startNavigation}>
          Start navigation
        </button>
      </div>
    </div>
  );
}
