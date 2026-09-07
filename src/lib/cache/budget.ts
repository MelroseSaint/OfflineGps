import { projectOntoPath, type LngLat } from '../geo';

export interface EvictMeta {
  key: string;
  tier: 'smart' | 'permanent';
  size: number;
  lastAccess: number;
  pinnedBy?: string;
  z: number;
  x: number;
  y: number;
}

export interface EvictionCtx {
  budgetBytes: number;
  autoCleanup: boolean;
  nowMs: number;
  /** Active route geometry, when navigating. */
  route: LngLat[] | null;
  /** Current progress along that route (meters), when known. */
  posAlongM: number | null;
  corridorM: number;
  keepBehindM: number;
}

export type Pressure = 'ok' | 'high' | 'critical';

export interface EvictionPlan {
  evict: string[];
  /** Bytes that remain after eviction. */
  remainingBytes: number;
  pressure: Pressure;
}

export function tileCenterLngLat(m: { z: number; x: number; y: number }): LngLat {
  const n = 2 ** m.z;
  const lng0 = (m.x / n) * 360 - 180;
  const lng1 = ((m.x + 1) / n) * 360 - 180;
  const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * m.y) / n))) * 180) / Math.PI;
  const lat0 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (m.y + 1)) / n))) * 180) / Math.PI;
  return [(lng0 + lng1) / 2, (lat0 + lat1) / 2];
}

/**
 * Pure eviction planner.
 *
 * Never evicts permanent downloads. Never evicts tiles that are part of the
 * active route corridor ahead of the user (or within keepBehindM behind).
 * Otherwise: oldest last-access first, farthest-from-user first.
 */
export function planEviction(metas: EvictMeta[], ctx: EvictionCtx): EvictionPlan {
  const smart = metas.filter((m) => m.tier === 'smart');
  const usedBytes = smart.reduce((s, m) => s + m.size, 0);
  const ratio = ctx.budgetBytes > 0 ? usedBytes / ctx.budgetBytes : 0;
  const pressure: Pressure = ratio > 1 ? 'critical' : ratio > 0.85 ? 'high' : 'ok';

  const target = Math.floor(ctx.budgetBytes * 0.9);
  if (!ctx.autoCleanup || usedBytes <= target) {
    return { evict: [], remainingBytes: usedBytes, pressure };
  }

  // Route-protection window: tiles within the corridor from keepBehindM
  // behind the user all the way to the destination are untouchable.
  const isProtected = (m: EvictMeta): boolean => {
    if (!m.pinnedBy || !ctx.route || ctx.route.length < 2) return false;
    const c = tileCenterLngLat(m);
    const pr = projectOntoPath(c, ctx.route);
    if (!pr) return false;
    if (pr.distM > ctx.corridorM) return false;
    return pr.alongM >= (ctx.posAlongM ?? 0) - ctx.keepBehindM;
  };

  const evictable = smart
    .filter((m) => !isProtected(m))
    .sort((a, b) => {
      // Oldest first…
      if (a.lastAccess !== b.lastAccess) return a.lastAccess - b.lastAccess;
      // …then farthest from the current position.
      return 0;
    });

  let bytes = usedBytes;
  const evict: string[] = [];
  for (const m of evictable) {
    if (bytes <= target) break;
    evict.push(m.key);
    bytes -= m.size;
  }
  return { evict, remainingBytes: bytes, pressure };
}
