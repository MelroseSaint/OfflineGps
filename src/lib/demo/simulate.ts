import { bearingDeg, destination, type LngLat } from '../geo';
import { pathLengthM } from '../geo';
import type { FixProvider, Fix } from '../gps';
import { pointAtDistance } from '../cache/corridor';
import type { Route } from '../types';

/**
 * DemoDrive — simulated GPS for testing navigation without driving.
 * Enabled with ?demo=1. Follows the active route at a configurable speed;
 * "leave road" mode drives straight off the route to exercise deviation
 * detection and offline rerouting.
 */
export class DemoDrive implements FixProvider {
  private onFix: ((f: Fix) => void) | null = null;
  private onStatus: ((s: 'ok') => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private alongM = 0;
  private route: Route | null = null;
  private offRoad = false;
  private offPos: LngLat | null = null;
  private offHeading = 90;
  private tick = 0;

  speedMps = 16;
  /** Deviation offset in meters once "leave road" is armed. */
  deviate = false;
  /** Where the simulated car idles when no route is loaded. */
  home: LngLat = [-76.884, 40.264];

  setRoute(route: Route | null): void {
    this.route = route;
    this.alongM = 0;
    this.offRoad = false;
    this.offPos = null;
  }

  reset(): void {
    this.alongM = 0;
    this.offRoad = false;
    this.offPos = null;
  }

  start(onFix: (f: Fix) => void, onStatus: (s: 'ok') => void): void {
    this.onFix = onFix;
    this.onStatus = onStatus;
    onStatus('ok');
    this.timer = setInterval(() => this.step(), 1000);
    this.step();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onFix = null;
    this.onStatus = null;
  }

  private step(): void {
    this.tick++;
    let pos: LngLat;
    let heading: number;
    let accuracy: number;

    if (this.deviate && !this.offRoad && this.route) {
      // Jump ~90m off the route perpendicular to the current heading.
      const p = pointAtDistance(this.route.points, this.alongM);
      const b = this.route.points.length > 1 ? bearingDeg(p, pointAtDistance(this.route.points, this.alongM + 50)) : 90;
      this.offPos = destination(p, b + 90, 90);
      this.offHeading = b + 35;
      this.offRoad = true;
    }

    if (this.offRoad) {
      const p = this.offPos ?? [0, 0];
      pos = destination(p as LngLat, this.offHeading, this.speedMps);
      this.offPos = pos;
      heading = this.offHeading;
      accuracy = 18 + Math.random() * 8;
    } else if (this.route) {
      this.alongM += this.speedMps;
      const total = pathLengthM(this.route.points);
      if (this.alongM > total) this.alongM = total;
      pos = pointAtDistance(this.route.points, this.alongM);
      const ahead = pointAtDistance(this.route.points, Math.min(total, this.alongM + 40));
      heading = bearingDeg(pos, ahead);
      accuracy = 5 + Math.random() * 7;
    } else {
      // Idle wander around the home point.
      pos = destination(this.home, this.tick * 37, 20);
      heading = this.tick * 37;
      accuracy = 8;
    }

    this.onFix?.({
      lat: pos[1],
      lng: pos[0],
      accuracy,
      speed: this.offRoad ? this.speedMps : this.speedMps,
      heading,
      ts: Date.now(),
    });
    this.onStatus?.('ok');
  }
}

export const demoDrive = new DemoDrive();
