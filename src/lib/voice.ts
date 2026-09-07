import { formatDistance } from './format';
import { settings } from './settings';
import type { Route } from './types';
import type { NavSnapshot } from './navigation/engine';

/**
 * Spoken turn-by-turn guidance via the Web Speech API.
 *
 * Works offline: on every major platform speechSynthesis exposes at least one
 * locally-installed voice (we prefer `localService` voices so announcements
 * never depend on a network cloud-voice). Announcements fire at standard
 * distance milestones before each maneuver and are deduplicated per milestone.
 */

/** Announcement thresholds in meters, announced once each per step. */
const MILESTONES_M = [2000, 800, 200];

class VoiceGuidance {
  private said = new Set<string>();
  private lastSpokenAt = 0;

  /** Call when a (new) route becomes active — re-arms all milestones. */
  reset(): void {
    this.said.clear();
  }

  /** Short notice when a deviation triggers replanning. */
  rerouting(): void {
    this.reset();
    this.speak('Recalculating route.');
  }

  /**
   * Feed each navigation snapshot; announces milestones as they are crossed.
   */
  announce(route: Route, snap: NavSnapshot): void {
    if (!settings.get().voice) return;
    if (snap.offRoute) return; // "Recalculating" already covers this

    const step = route.steps[snap.nextStepIndex];
    if (!step) return;
    const dist = snap.distToStepM;

    if (step.type === 'arrive') {
      if (dist <= 300 && !this.said.has('arrive')) {
        this.said.add('arrive');
        this.speak('You have arrived at your destination.', { interrupt: true });
      }
      return;
    }

    for (const m of MILESTONES_M) {
      if (dist > m) continue;
      const key = `${snap.nextStepIndex}:${m}`;
      if (this.said.has(key)) continue;
      // Don't announce the far milestone if we're already past it and close to
      // the next (avoids double-fire right after a reroute).
      const nearer = MILESTONES_M.find((x) => x < m && dist <= x);
      if (nearer !== undefined) continue;
      this.said.add(key);
      const units = settings.get().units;
      const text =
        m === 200
          ? spokenInstruction(step) // close milestone: no distance prefix
          : `In ${formatDistance(m, units).replace('≈', '')}, ${spokenInstruction(step).charAt(0).toLowerCase()}${spokenInstruction(step).slice(1)}`;
      this.speak(text, { interrupt: m === 200 });
      return; // one announcement per fix
    }
  }

  speak(text: string, opts: { interrupt?: boolean } = {}): void {
    if (!settings.get().voice || typeof speechSynthesis === 'undefined') return;
    // Throttle overlapping chatter (except intentional interrupts).
    if (!opts.interrupt && Date.now() - this.lastSpokenAt < 1500) return;
    try {
      if (opts.interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickVoice();
      if (voice) u.voice = voice;
      u.rate = 1;
      u.pitch = 1;
      u.volume = 1;
      this.lastSpokenAt = Date.now();
      speechSynthesis.speak(u);
    } catch {
      // Speech synthesis unavailable — silent degradation is fine.
    }
  }
}

function spokenInstruction(step: { type: string; modifier?: string; name: string }): string {
  const onto = step.name ? ` onto ${step.name}` : '';
  switch (step.type) {
    case 'depart':
      return step.name ? `Continue on ${step.name}` : 'Begin the route';
    case 'merge':
      return `Merge${onto}`;
    case 'roundabout':
      return step.name ? `At the roundabout, take the exit onto ${step.name}` : 'Enter the roundabout';
    case 'continue':
      return `Continue${step.name ? ` on ${step.name}` : ''}`;
    case 'arrive':
      return 'You have arrived';
    default: {
      const mod = step.modifier ?? 'straight';
      if (mod === 'straight') return `Continue straight${onto}`;
      if (mod === 'uturn') return `Make a U-turn${onto}`;
      return `Turn ${mod}${onto}`;
    }
  }
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const pool = en.length > 0 ? en : voices;
  return pool.find((v) => v.localService) ?? pool[0];
}

// Some platforms populate voices asynchronously.
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => {
    /* warm the cache */
  };
}

export const voice = new VoiceGuidance();
