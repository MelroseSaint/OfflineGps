import { angleDiff, bearingDeg, type LngLat } from '../geo';
import type { RoutePath } from './astar';
import type { GraphEdge, RoutingGraph } from './graph';
import type { ManeuverModifier, ManeuverType, Route, RouteStep } from '../types';

const CLASS_PHRASE: Record<string, string> = {
  motorway: 'the motorway',
  motorway_link: 'the ramp',
  trunk: 'the trunk road',
  trunk_link: 'the ramp',
  primary: 'the primary road',
  primary_link: 'the ramp',
  secondary: 'the secondary road',
  secondary_link: 'the ramp',
  tertiary: 'the tertiary road',
  tertiary_link: 'the ramp',
  unclassified: 'the road',
  residential: 'the street',
  living_street: 'the street',
  service: 'the service road',
  track: 'the track',
};

function roadName(e: GraphEdge): string {
  if (e.name) return e.name;
  return CLASS_PHRASE[e.cls] ?? 'the road';
}

function edgeStartBearing(g: RoutingGraph, e: GraphEdge): number {
  const from = g.nodes[e.from].coord;
  const next = e.shape[0] ?? g.nodes[e.to].coord;
  return bearingDeg(from, next);
}

function edgeEndBearing(g: RoutingGraph, e: GraphEdge): number {
  const prev = e.shape[e.shape.length - 1] ?? g.nodes[e.from].coord;
  const to = g.nodes[e.to].coord;
  return bearingDeg(prev, to);
}

function modifierFor(delta: number): ManeuverModifier | undefined {
  const a = Math.abs(delta);
  const dir: 'left' | 'right' = delta > 0 ? 'right' : 'left';
  if (a >= 160) return 'uturn';
  if (a >= 120) return dir === 'right' ? 'sharp right' : 'sharp left';
  if (a >= 45) return dir;
  if (a >= 20) return dir === 'right' ? 'slight right' : 'slight left';
  return 'straight';
}

/**
 * Assemble a full Route (geometry + turn-by-turn steps) from a graph path.
 * Steps are emitted at junctions where the road name changes or the bearing
 * changes beyond a threshold.
 */
export function assembleRoute(g: RoutingGraph, path: RoutePath): Route {
  const points: LngLat[] = [];
  const edges: GraphEdge[] = path.edges.map((id) => g.edges[id]);

  // Build point list: for each edge, its start node coord + shape; finally the
  // last node coord. Track the point index of each node along the way.
  const nodePointIndex = new Map<number, number>();
  const first = g.nodes[path.nodes[0]];
  points.push(first.coord);
  nodePointIndex.set(first.id, 0);
  for (const e of edges) {
    for (const p of e.shape) points.push(p);
    const toCoord = g.nodes[e.to].coord;
    nodePointIndex.set(e.to, points.length);
    points.push(toCoord);
  }

  // Cumulative distance/duration per point.
  const cumDist: number[] = new Array(points.length).fill(0);
  const cumDur: number[] = new Array(points.length).fill(0);
  {
    let d = 0;
    let t = 0;
    for (let i = 1; i < points.length; i++) {
      // Approximate per-point distance; edges carry the exact length.
      const a = points[i - 1];
      const b = points[i];
      const R = 6371008.8;
      const dLat = (b[1] - a[1]) * (Math.PI / 180);
      const dLng = (b[0] - a[0]) * (Math.PI / 180) * Math.cos((a[1] * Math.PI) / 180);
      d += Math.sqrt(dLat * dLat + dLng * dLng) * R;
      // Duration: find the edge that owns this point (ends at point i).
      const e = edges[i - 1];
      if (e) t += e.weight;
      cumDist[i] = d;
      cumDur[i] = t;
    }
  }

  const steps: RouteStep[] = [];
  const pushStep = (
    type: ManeuverType,
    name: string,
    pointIndex: number,
    modifier?: ManeuverModifier,
  ): void => {
    steps.push({
      type,
      name,
      modifier,
      location: points[pointIndex],
      pointIndex,
      distanceM: 0,
      durationS: 0,
      cumDistM: cumDist[pointIndex],
      cumDurS: cumDur[pointIndex],
    });
  };

  pushStep('depart', edges.length > 0 ? roadName(edges[0]) : '', 0);

  for (let i = 1; i < edges.length; i++) {
    const prev = edges[i - 1];
    const next = edges[i];
    const delta = angleDiff(edgeEndBearing(g, prev), edgeStartBearing(g, next));
    const junction = g.nodes[next.from].in.length + g.nodes[next.from].out.length > 2;
    const nameChange = prev.name !== next.name;
    const significantTurn = Math.abs(delta) >= 25 || (Math.abs(delta) >= 60 && nameChange);
    const linkToMain =
      (prev.cls.endsWith('_link') || prev.cls === 'service') &&
      ['motorway', 'trunk', 'primary'].includes(next.cls);

    if (!junction && !significantTurn) continue;

    // Maneuver suppression: merges emitted when instructions would be
    // unnavigable (stitch connectors and micro-segments produce chains of
    // sub-40 m turns).
    const lastPushed = steps[steps.length - 1];
    if (lastPushed && steps.length > 1) {
      const gap = cumDist[nodePointIndex.get(next.from) ?? 0] - lastPushed.cumDistM;
      if (gap < 40) continue;
    }

    let type: ManeuverType;
    let modifier = modifierFor(delta);
    if (linkToMain && next.ramp !== 1) {
      type = 'merge';
      if (modifier === 'straight' || modifier === 'uturn') modifier = undefined;
    } else if (next.roundabout) {
      type = 'roundabout';
    } else if (Math.abs(delta) < 20) {
      // Straight through a junction on the same road is not an instruction.
      if (!nameChange) continue;
      type = 'continue';
      modifier = 'straight';
    } else {
      type = 'turn';
    }
    pushStep(type, roadName(next), nodePointIndex.get(next.from) ?? 0, modifier);
  }

  if (points.length > 1) {
    pushStep('arrive', '', points.length - 1);
  }

  // Fill step distances/durations to the following step.
  for (let i = 0; i < steps.length; i++) {
    const nextIdx = i + 1 < steps.length ? steps[i + 1].pointIndex : points.length - 1;
    steps[i].distanceM = cumDist[nextIdx] - steps[i].cumDistM;
    steps[i].durationS = cumDur[nextIdx] - steps[i].cumDurS;
  }

  // A `depart` immediately followed by a `continue` on the same geometry is
  // redundant — fold the name into the depart step.
  if (steps.length > 2 && steps[1].type === 'continue' && steps[1].distanceM < 200) {
    if (steps[1].name && !steps[0].name) steps[0].name = steps[1].name;
    steps.splice(1, 1);
    steps[0].distanceM = steps[1] ? steps[1].cumDistM : steps[0].distanceM;
  }

  return {
    points,
    distanceM: path.distM,
    durationS: path.weightS,
    steps,
    createdAt: Date.now(),
  };
}
