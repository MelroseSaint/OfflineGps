import { appStore, clearRoute, setCamera, useStore } from '../app/state';
import { formatDistance, formatDuration, formatEta } from '../lib/format';
import { settings } from '../lib/settings';
import type { ManeuverModifier } from '../lib/types';

function arrowRotation(m: ManeuverModifier | undefined): number {
  switch (m) {
    case 'uturn':
      return 160;
    case 'sharp right':
      return 110;
    case 'sharp left':
      return -110;
    case 'right':
      return 85;
    case 'left':
      return -85;
    case 'slight right':
      return 35;
    case 'slight left':
      return -35;
    default:
      return 0;
  }
}

function instructionText(step: { type: string; modifier?: ManeuverModifier; name: string }): string {
  const onto = step.name ? ` onto ${step.name}` : '';
  switch (step.type) {
    case 'depart':
      return `Head out${step.name ? ` on ${step.name}` : ''}`;
    case 'merge':
      return `Merge${onto}`;
    case 'roundabout':
      return `Enter the roundabout${step.name ? `, exit onto ${step.name}` : ''}`;
    case 'continue':
      return `Continue${step.name ? ` on ${step.name}` : ''}`;
    case 'arrive':
      return 'Arrive at your destination';
    default: {
      const mod = step.modifier ?? 'straight';
      if (mod === 'straight') return `Continue straight${onto}`;
      if (mod === 'uturn') return `Make a U-turn${onto}`;
      return `Turn ${mod}${onto}`;
    }
  }
}

/**
 * Google Maps-style navigation HUD:
 *  - dark full-width maneuver banner at the top (arrow · distance · road),
 *    with a "then …" secondary line for the following maneuver;
 *  - dark bottom bar with remaining time/distance (left) and ETA (right),
 *    a thin route progress bar, and circular controls bottom-right.
 */
export default function NavHud(): React.ReactNode | null {
  const s = useStore(appStore);
  const stg = useStore(settings.store);
  if (!s.navActive || !s.route || !s.navSnap) return null;
  const snap = s.navSnap;
  const route = s.route;
  const step = route.steps[snap.nextStepIndex] ?? route.steps[route.steps.length - 1];
  const following = route.steps[snap.nextStepIndex + 1];
  const turnDist = snap.distToStepM;
  const arrived = step?.type === 'arrive';

  return (
    <>
      {/* Top maneuver banner */}
      {!snap.offRoute && step && !arrived && (
        <div className="gms-banner">
          <div className="gms-banner-main">
            <svg className="gms-arrow" viewBox="0 0 24 24" style={{ transform: `rotate(${arrowRotation(step.modifier)}deg)` }}>
              <path d="M12 2 L19 20 L12 15.5 L5 20 Z" fill="currentColor" />
            </svg>
            <div className="gms-banner-text">
              <div className="gms-turn-dist">{formatDistance(turnDist, 'metric')}</div>
              <div className="gms-turn-inst">{instructionText(step)}</div>
            </div>
          </div>
          {following && following.type !== 'arrive' && (
            <div className="gms-banner-then">
              Then {instructionText(following).charAt(0).toLowerCase() + instructionText(following).slice(1)}
            </div>
          )}
        </div>
      )}
      {arrived && (
        <div className="gms-banner">
          <div className="gms-banner-main">
            <div className="gms-banner-text">
              <div className="gms-turn-inst">Arriving at your destination</div>
            </div>
          </div>
        </div>
      )}
      {snap.offRoute && (
        <div className="gms-banner gms-rerouting">
          <div className="gms-banner-main">
            <div className="gms-banner-text">
              <div className="gms-turn-inst">Rerouting…</div>
              <div className="gms-banner-sub">
                {s.net === 'offline'
                  ? 'Using your offline map data'
                  : 'Finding a new route'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bottom ETA bar */}
      <div className="gms-bottom">
        <div className="gms-progress">
          <div
            className="gms-progress-fill"
            style={{ width: `${Math.min(100, (snap.alongM / Math.max(1, route.distanceM)) * 100)}%` }}
          />
        </div>
        <div className="gms-bottom-row">
          <div className="gms-remaining">
            <span className="gms-time">{formatDuration(snap.remainingS)}</span>
            <span className="gms-dist">{formatDistance(snap.remainingM, 'metric')}</span>
          </div>
          <div className="gms-eta">
            <span className="gms-eta-time">{formatEta(snap.remainingS)}</span>
            <span className="gms-eta-label">ETA</span>
          </div>
          <div className="gms-controls">
            <button
              className="gms-round"
              onClick={() => settings.update({ voice: !stg.voice })}
              title={stg.voice ? 'Mute voice guidance' : 'Unmute voice guidance'}
            >
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M4 9.5 L7.5 9.5 L12 5 L12 19 L7.5 14.5 L4 14.5 Z" fill="currentColor" />
                {stg.voice ? (
                  <>
                    <path d="M15 9 C16.4 10.4 16.4 13.6 15 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M17.5 6.8 C20.2 9.5 20.2 14.5 17.5 17.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </>
                ) : (
                  <>
                    <line x1="15" y1="9" x2="21" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <line x1="21" y1="9" x2="15" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </>
                )}
              </svg>
            </button>
            <button className="gms-round" onClick={() => setCamera('overview')} title="Route overview">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M4 18 L10 18 M14 18 L20 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <circle cx="12" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            </button>
            <button className="gms-round" onClick={() => setCamera('follow')} title="Recenter">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <circle cx="12" cy="12" r="4" fill="currentColor" />
                <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
            <button className="gms-round gms-exit" onClick={clearRoute} title="Exit navigation">
              ✕
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
