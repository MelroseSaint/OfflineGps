import type { ReactNode } from 'react';
import { appStore, openPanel, setThreeD, useStore } from '../app/state';
import { formatSpeed } from '../lib/format';
import type { NetState } from '../lib/net';

const NET_LABEL: Record<NetState, string> = {
  online: 'Online',
  degraded: 'Weak connection',
  offline: 'Offline',
};

const NET_CLASS: Record<NetState, string> = {
  online: 'chip-green',
  degraded: 'chip-amber',
  offline: 'chip-blue',
};

export default function StatusBar(): ReactNode {
  const s = useStore(appStore);
  const fix = s.fix;
  const navOffline = s.navActive && s.net !== 'online';
  return (
    <div className="status-bar">
      <button
        className={`chip ${NET_CLASS[s.net]}`}
        title={
          s.net === 'offline'
            ? 'Using locally cached map and routing data.'
            : s.net === 'degraded'
              ? 'Connection unstable — using cache where needed.'
              : 'Connected.'
        }
      >
        <span className="dot" />
        {navOffline ? 'Offline Navigation' : NET_LABEL[s.net]}
      </button>
      <div className={`chip ${s.gpsStale || s.gpsStatus !== 'ok' ? 'chip-amber' : 'chip-plain'}`}>
        {s.gpsStatus === 'ok' && fix && !s.gpsStale
          ? `GPS ±${Math.round(fix.accuracy)} m`
          : s.gpsStatus === 'denied'
            ? 'GPS denied'
            : s.gpsStatus === 'unavailable'
              ? 'No GPS'
              : 'GPS…'}
      </div>
      {fix?.speed != null && <div className="chip chip-plain">{formatSpeed(fix.speed, 'metric')}</div>}
      {s.cache.pressure !== 'ok' && (
        <div className="chip chip-red" title="Smart cache is near its storage limit">
          {s.cache.pressure === 'critical' ? 'Storage full' : 'Storage high'}
        </div>
      )}
      <div className="spacer" />
      <button
        className={`icon-btn ${s.threeD ? 'active' : ''}`}
        onClick={() => setThreeD(!s.threeD)}
        title={s.threeD ? 'Switch to 2D view' : 'Switch to 3D view'}
        aria-label={s.threeD ? 'Switch to 2D view' : 'Switch to 3D view'}
      >
        3D
      </button>
      <button className="icon-btn" onClick={() => openPanel('settings')} aria-label="Settings">
        ☰
      </button>
    </div>
  );
}
