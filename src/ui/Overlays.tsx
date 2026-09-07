import { appStore, useStore } from '../app/state';
import { demoDrive } from '../lib/demo/simulate';
import type { ReactNode } from 'react';

export function Toasts(): ReactNode {
  const s = useStore(appStore);
  return (
    <div className="toasts">
      {s.toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function DemoPanel(): ReactNode | null {
  const s = useStore(appStore);
  if (!s.demo) return null;
  return (
    <div className="demo-panel">
      <b>Demo drive</b>
      <label className="toggle">
        <input
          type="checkbox"
          checked={demoDrive.speedMps >= 30}
          onChange={(e) => {
            demoDrive.speedMps = e.target.checked ? 32 : 16;
          }}
        />
        <span>Fast (2×)</span>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={demoDrive.deviate}
          onChange={(e) => {
            demoDrive.deviate = e.target.checked;
          }}
        />
        <span>Leave road (test reroute)</span>
      </label>
      <button
        className="ghost small"
        onClick={() => {
          demoDrive.setRoute(s.route);
          demoDrive.reset();
        }}
      >
        Restart on route
      </button>
      <span className="subtle">Simulated GPS replaces real GPS in demo mode.</span>
    </div>
  );
}
