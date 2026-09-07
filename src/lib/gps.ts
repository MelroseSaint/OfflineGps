import { Store } from './store';

export interface Fix {
  lat: number;
  lng: number;
  /** GPS accuracy radius in meters. */
  accuracy: number;
  /** m/s if the device reports it. */
  speed: number | null;
  /** Heading in degrees (true north) from device compass or course over ground. */
  heading: number | null;
  ts: number;
}

export type GpsStatus = 'idle' | 'requesting' | 'ok' | 'denied' | 'unavailable' | 'error';

export interface FixProvider {
  start(onFix: (f: Fix) => void, onStatus: (s: GpsStatus, msg?: string) => void): void;
  stop(): void;
}

export const systemGpsProvider: FixProvider = (() => {
  let watchId: number | null = null;
  let last: Fix | null = null;
  return {
    start(onFix, onStatus) {
      if (!('geolocation' in navigator)) {
        onStatus('unavailable', 'Geolocation is not supported by this device.');
        return;
      }
      onStatus('requesting');
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const f: Fix = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? 50,
            speed: pos.coords.speed ?? null,
            heading: pos.coords.heading ?? null,
            ts: pos.timestamp,
          };
          // Course over ground when the device does not supply heading.
          if (f.heading == null && f.speed != null && f.speed > 1.5 && last) {
            const dLat = f.lat - last.lat;
            const dLng = (f.lng - last.lng) / Math.max(0.2, Math.cos((f.lat * Math.PI) / 180));
            if (dLat !== 0 || dLng !== 0) {
              f.heading = ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360;
            }
          }
          last = f;
          onFix(f);
          onStatus('ok');
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) onStatus('denied', 'Location permission denied.');
          else if (err.code === err.POSITION_UNAVAILABLE)
            onStatus('unavailable', 'GPS position unavailable.');
          else if (err.code === err.TIMEOUT) onStatus('error', 'GPS timeout — searching…');
          else onStatus('error', err.message);
        },
        { enableHighAccuracy: true, maximumAge: 1500, timeout: 20000 },
      );
    },
    stop() {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      last = null;
    },
  };
})();

class Positioner {
  readonly store = new Store<{
    fix: Fix | null;
    status: GpsStatus;
    message?: string;
    /** Age of the last fix, refreshed on a timer so the UI can flag GPS loss. */
    stale: boolean;
  }>({ fix: null, status: 'idle', stale: true });

  private provider: FixProvider = systemGpsProvider;
  private running = false;
  private ageTimer: ReturnType<typeof setInterval> | null = null;

  setProvider(p: FixProvider): void {
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.provider = p;
    if (wasRunning) this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.provider.start(this.onFix, this.onStatus);
    this.ageTimer = setInterval(() => {
      const fix = this.store.get().fix;
      if (fix) {
        const stale = Date.now() - fix.ts > 12_000;
        if (stale !== this.store.get().stale) this.store.set({ stale });
      }
    }, 3000);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.provider.stop();
    if (this.ageTimer) clearInterval(this.ageTimer);
    this.ageTimer = null;
  }

  private onFix = (fix: Fix): void => {
    this.store.set({ fix, status: 'ok', stale: false });
  };

  private onStatus = (status: GpsStatus, message?: string): void => {
    this.store.set({ status, message });
  };
}

export const positioner = new Positioner();
