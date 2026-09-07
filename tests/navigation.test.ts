import { describe, expect, it, vi } from 'vitest';
import { NavigationEngine } from '../src/lib/navigation/engine';
import type { Route } from '../src/lib/types';

function straightRoute(lenM = 10_000): Route {
  // ~0.09 deg per km in lng at these latitudes; build a horizontal line.
  const n = 100;
  const points: [number, number][] = [];
  const dLng = (lenM / 1000) * 0.0122 / n;
  for (let i = 0; i <= n; i++) points.push([-77.0 + i * dLng, 40.0]);
  const stepLen = lenM / 2;
  return {
    points,
    distanceM: lenM,
    durationS: 600,
    createdAt: Date.now(),
    steps: [
      { type: 'depart', name: 'Main St', location: points[0], distanceM: stepLen, durationS: 300, cumDistM: 0, cumDurS: 0, pointIndex: 0 },
      { type: 'turn', modifier: 'left', name: 'Other St', location: points[Math.floor(n / 2)], distanceM: stepLen, durationS: 300, cumDistM: stepLen, cumDurS: 300, pointIndex: Math.floor(n / 2) },
      { type: 'arrive', name: '', location: points[n], distanceM: 0, durationS: 0, cumDistM: lenM, cumDurS: 600, pointIndex: n },
    ],
  };
}

describe('NavigationEngine', () => {
  it('tracks progress and next maneuver', () => {
    const eng = new NavigationEngine({ onRerouteNeeded: vi.fn(), onArrived: vi.fn() });
    eng.setRoute(straightRoute());
    const snap = eng.onFix({ lng: -77.0 + 0.0122 * 2, lat: 40.0002, accuracy: 8 });
    expect(snap).not.toBeNull();
    expect(snap!.offRoute).toBe(false);
    expect(snap!.alongM).toBeGreaterThan(1500);
    expect(snap!.remainingM).toBeLessThan(9000);
    expect(snap!.nextStepIndex).toBe(1); // the turn step
    expect(snap!.distToStepM).toBeGreaterThan(0);
  });

  it('does not trigger reroute for GPS jitter within threshold', () => {
    const reroute = vi.fn();
    const eng = new NavigationEngine({ onRerouteNeeded: reroute, onArrived: vi.fn() });
    eng.setRoute(straightRoute());
    // 20 m off the line (threshold with accuracy 8 → 35 m).
    eng.onFix({ lng: -77.0 + 0.0122, lat: 40.00018, accuracy: 8 });
    eng.onFix({ lng: -77.0 + 0.0122 * 2, lat: 40.00018, accuracy: 8 });
    expect(reroute).not.toHaveBeenCalled();
  });

  it('triggers reroute after consecutive off-route fixes and cools down', () => {
    const reroute = vi.fn();
    const eng = new NavigationEngine({ onRerouteNeeded: reroute, onArrived: vi.fn() }, 50);
    eng.setRoute(straightRoute());
    // ~120 m off route, twice.
    eng.onFix({ lng: -77.0 + 0.0122, lat: 40.0012, accuracy: 8 });
    eng.onFix({ lng: -77.0 + 0.0122 * 2, lat: 40.0012, accuracy: 8 });
    expect(reroute).toHaveBeenCalledTimes(1);
    // Within cooldown: more off-route fixes don't re-trigger.
    eng.onFix({ lng: -77.0 + 0.0122 * 3, lat: 40.0012, accuracy: 8 });
    expect(reroute).toHaveBeenCalledTimes(1);
  });

  it('recovers: back on route resets the counter', () => {
    const reroute = vi.fn();
    const eng = new NavigationEngine({ onRerouteNeeded: reroute, onArrived: vi.fn() }, 50);
    eng.setRoute(straightRoute());
    eng.onFix({ lng: -77.0 + 0.0122, lat: 40.0012, accuracy: 8 }); // off once
    eng.onFix({ lng: -77.0 + 0.0122 * 2, lat: 40.00005, accuracy: 8 }); // back on
    eng.onFix({ lng: -77.0 + 0.0122 * 3, lat: 40.00005, accuracy: 8 });
    expect(reroute).not.toHaveBeenCalled();
  });

  it('fires arrival near the route end', () => {
    const arrived = vi.fn();
    const eng = new NavigationEngine({ onRerouteNeeded: vi.fn(), onArrived: arrived });
    eng.setRoute(straightRoute());
    const snap = eng.onFix({ lng: -77.0 + 0.0122 * 99.95, lat: 40.00002, accuracy: 8 });
    expect(snap!.arrived).toBe(true);
    expect(arrived).toHaveBeenCalledTimes(1);
  });

  it('new route resets state (reroute flow)', () => {
    const reroute = vi.fn();
    const eng = new NavigationEngine({ onRerouteNeeded: reroute, onArrived: vi.fn() }, 0);
    eng.setRoute(straightRoute());
    eng.onFix({ lng: -77.0 + 0.0122, lat: 40.0012, accuracy: 8 });
    eng.onFix({ lng: -77.0 + 0.0122 * 2, lat: 40.0012, accuracy: 8 });
    expect(reroute).toHaveBeenCalledTimes(1);
    eng.setRoute(straightRoute());
    eng.onFix({ lng: -77.0 + 0.0122, lat: 40.00005, accuracy: 8 });
    expect(eng.onFix({ lng: -77.0 + 0.0122 * 2, lat: 40.0012, accuracy: 8 })!.offRoute).toBe(true);
    // Cooldown was reset by setRoute? No — cooldown is time-based; counter reset.
    // After cooldown expiry a new reroute can fire (tested via cooldown=0 above implicitly).
  });
});
