import { projectOntoPath, type LngLat } from '../geo';
import type { Route } from '../types';

export interface NavSnapshot {
  alongM: number;
  remainingM: number;
  remainingS: number;
  /** Next maneuver step (not yet passed). */
  nextStepIndex: number;
  distToStepM: number;
  offRoute: boolean;
  offRouteDistM: number;
  arrived: boolean;
}

export interface EngineCallbacks {
  onRerouteNeeded: (fix: LngLat) => void;
  onArrived: () => void;
}

/**
 * NavigationEngine — pure logic, no DOM/worker dependencies (unit-tested).
 *
 * Deviation policy: a fix is "off route" when its distance to the route
 * polyline exceeds max(35 m, accuracy × 1.8). Two consecutive off-route fixes
 * (or one wildly-off fix) trigger a reroute request, rate-limited by a
 * cooldown so GPS jitter cannot thrash the router.
 */
export class NavigationEngine {
  private route: Route | null = null;
  private offCount = 0;
  private lastRerouteAt = 0;
  private arrivedFired = false;

  constructor(
    private readonly cb: EngineCallbacks,
    private readonly cooldownMs = 8000,
  ) {}

  get current(): Route | null {
    return this.route;
  }

  setRoute(route: Route): void {
    this.route = route;
    this.offCount = 0;
    this.arrivedFired = false;
  }

  stop(): void {
    this.route = null;
    this.offCount = 0;
    this.arrivedFired = false;
  }

  onFix(fix: { lng: number; lat: number; accuracy: number }): NavSnapshot | null {
    const route = this.route;
    if (!route || route.points.length < 2) return null;
    const pr = projectOntoPath([fix.lng, fix.lat], route.points);
    if (!pr) return null;

    const threshold = Math.max(35, fix.accuracy * 1.8);
    const off = pr.distM > threshold;
    this.offCount = off ? this.offCount + 1 : Math.max(0, this.offCount - 1);

    const alongM = Math.max(0, Math.min(pr.alongM, route.distanceM));
    const remainingM = Math.max(0, route.distanceM - alongM);

    // Remaining time: interpolate within the enclosing step using cumulative
    // step durations from the speed model.
    let remainingS = 0;
    let nextStepIndex = route.steps.length - 1;
    for (let i = 0; i < route.steps.length; i++) {
      const s = route.steps[i];
      const nextCum = i + 1 < route.steps.length ? route.steps[i + 1].cumDistM : route.distanceM;
      if (alongM <= nextCum || i === route.steps.length - 1) {
        nextStepIndex = i + 1 < route.steps.length ? i + 1 : i;
        const segLen = Math.max(1, nextCum - s.cumDistM);
        const frac = Math.max(0, Math.min(1, (alongM - s.cumDistM) / segLen));
        const nextCumDur =
          i + 1 < route.steps.length ? route.steps[i + 1].cumDurS : route.durationS;
        const elapsed = s.cumDurS + frac * (nextCumDur - s.cumDurS);
        remainingS = Math.max(0, route.durationS - elapsed);
        break;
      }
    }

    // Distance to the next maneuver.
    let distToStepM = 0;
    for (let i = nextStepIndex; i < route.steps.length; i++) {
      const s = route.steps[i];
      if (s.type === 'arrive') continue;
      if (s.cumDistM >= alongM) {
        nextStepIndex = i;
        distToStepM = s.cumDistM - alongM;
        break;
      }
    }

    const arrived = remainingM < 25;
    if (arrived && !this.arrivedFired) {
      this.arrivedFired = true;
      this.cb.onArrived();
    }

    const severe = pr.distM > threshold * 4;
    if ((this.offCount >= 2 || (severe && off)) && Date.now() - this.lastRerouteAt > this.cooldownMs && !arrived) {
      this.lastRerouteAt = Date.now();
      this.cb.onRerouteNeeded([fix.lng, fix.lat]);
    }

    return {
      alongM,
      remainingM,
      remainingS,
      nextStepIndex,
      distToStepM,
      offRoute: off,
      offRouteDistM: pr.distM,
      arrived,
    };
  }
}
