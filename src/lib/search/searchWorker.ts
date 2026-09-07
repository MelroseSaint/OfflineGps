/// <reference lib="webworker" />
import { getDB } from '../storage/db';
import type { SearchDoc } from '../storage/db';

interface RebuildMsg {
  type: 'rebuild';
}
interface QueryMsg {
  type: 'query';
  id: number;
  text: string;
  center?: [number, number];
  limit?: number;
}

type Req = RebuildMsg | QueryMsg;

export interface QueryReply {
  type: 'query-result';
  id: number;
  docs: { name: string; kind: string; lat: number; lng: number; context?: string }[];
}

let docs: SearchDoc[] = [];
let sorted: SearchDoc[] = [];

function lowerBound(arr: SearchDoc[], norm: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].norm < norm) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function score(d: SearchDoc, q: string, center?: [number, number]): number {
  let s = d.boost;
  if (d.norm === q) s += 100;
  else if (d.norm.startsWith(q)) s += 60;
  const firstWord = d.norm.split(/\s+/)[0] ?? '';
  if (firstWord.startsWith(q)) s += 25;
  if (center) {
    const R = 6371008.8;
    const dLat = (d.lat - center[1]) * (Math.PI / 180);
    const dLng = (d.lng - center[0]) * (Math.PI / 180);
    const dist =
      2 * R * Math.asin(
        Math.min(
          1,
          Math.sqrt(
            Math.sin(dLat / 2) ** 2 + Math.cos(d.lat * (Math.PI / 180)) * Math.cos(center[1] * (Math.PI / 180)) * Math.sin(dLng / 2) ** 2,
          ),
        ),
      );
    s *= 1 / (1 + dist / 4000); // strong local bias
  }
  return s;
}

async function rebuild(): Promise<void> {
  const db = await getDB();
  docs = await db.getAll('search-index');
  sorted = docs.slice().sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
}

async function query(msg: QueryMsg): Promise<QueryReply> {
  if (sorted.length === 0) await rebuild();
  const q = msg.text.trim().toLowerCase();
  const limit = msg.limit ?? 12;
  if (!q) return { type: 'query-result', id: msg.id, docs: [] };

  const candidates: SearchDoc[] = [];
  // Prefix matches via binary search.
  const lo = lowerBound(sorted, q);
  for (let i = lo; i < sorted.length && sorted[i].norm.startsWith(q); i++) {
    candidates.push(sorted[i]);
  }
  // Substring fallback when few prefix hits (bounded scan).
  if (candidates.length < limit) {
    for (const d of sorted) {
      if (candidates.length >= limit * 6) break;
      if (d.norm.includes(q) && !d.norm.startsWith(q)) candidates.push(d);
    }
  }

  const ranked = candidates
    .map((d) => ({ d, s: score(d, q, msg.center) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ d }) => ({ name: d.name, kind: d.kind, lat: d.lat, lng: d.lng, context: d.context }));

  return { type: 'query-result', id: msg.id, docs: ranked };
}

self.onmessage = (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  if (msg.type === 'rebuild') {
    void rebuild().then(() =>
      (self as unknown as Worker).postMessage({ type: 'rebuild-done', count: docs.length }),
    );
  } else if (msg.type === 'query') {
    void query(msg).then((r) => (self as unknown as Worker).postMessage(r));
  }
};
