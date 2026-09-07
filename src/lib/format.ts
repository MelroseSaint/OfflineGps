import type { Units } from './settings';

export function formatDistance(m: number, units: Units): string {
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 528) return `${Math.round(ft / 10) * 10} ft`;
    const mi = m / 1609.344;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function formatDuration(s: number): string {
  const mins = Math.round(s / 60);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatEta(remainingS: number, now = Date.now()): string {
  const eta = new Date(now + remainingS * 1000);
  return eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatSpeed(mps: number | null, units: Units): string {
  if (mps == null) return '—';
  return units === 'imperial'
    ? `${Math.round(mps * 2.23694)} mph`
    : `${Math.round(mps * 3.6)} km/h`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
