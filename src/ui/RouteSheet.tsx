import { appStore, clearRoute, clearSelection, planFromSelection, startNavigation, stopNavigation, useStore } from '../app/state';
import { formatDistance, formatDuration, formatEta } from '../lib/format';

const PHASE_LABEL: Record<string, string> = {
  coarse: 'Downloading trip map data…',
  corridor: 'Caching the route corridor…',
  done: 'Ready',
};

export default function RouteSheet(): React.ReactNode {
  const s = useStore(appStore);

  // Arrival state — prominent banner with Done button.
  if (s.arrived && s.route) {
    const destName = s.routeDest ?? s.selected?.name ?? 'Destination';
    return (
      <div className="sheet route-sheet arrived-sheet">
        <div className="arrived-icon">✓</div>
        <div className="route-title">Arrived</div>
        <div className="route-sub">{destName}</div>
        <button className="primary full" onClick={clearRoute}>
          Done
        </button>
      </div>
    );
  }

  // Destination picked, route not planned yet (Google Maps-style preview).
  if (s.selected && !s.route && !s.planning.busy) {
    const originLabel = s.origin?.name ?? 'My location';
    return (
      <div className="sheet route-sheet">
        <div className="route-preview-fromto">
          <div className="route-preview-row">
            <span className="route-preview-dot route-preview-dot-origin" />
            <span className="route-preview-text">{originLabel}</span>
          </div>
          <div className="route-preview-row">
            <span className="route-preview-dot route-preview-dot-dest" />
            <span className="route-preview-text">{s.selected.name}</span>
          </div>
        </div>
        {s.selected.detail && <div className="route-sub">{s.selected.detail}</div>}
        <div className="row-buttons">
          <button className="ghost" onClick={clearSelection}>
            Close
          </button>
          <button className="primary" onClick={() => void planFromSelection()}>
            Route
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

  if (!s.route) return null;
  const destName = s.routeDest ?? s.selected?.name ?? 'Destination';
  const originLabel = s.origin?.name ?? 'My location';

  return (
    <div className="sheet route-sheet">
      <div className="route-preview-fromto">
        <div className="route-preview-row">
          <span className="route-preview-dot route-preview-dot-origin" />
          <span className="route-preview-text">{originLabel}</span>
        </div>
        <div className="route-preview-row">
          <span className="route-preview-dot route-preview-dot-dest" />
          <span className="route-preview-text">{destName}</span>
        </div>
      </div>
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
          Cancel
        </button>
        <button className="primary" onClick={startNavigation}>
          Start navigation
        </button>
      </div>
    </div>
  );
}
