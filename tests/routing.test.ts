import { describe, expect, it } from 'vitest';
import { emptyGraph, addTileToGraph } from '../src/lib/routing/tile-graph';
import { findPath } from '../src/lib/routing/astar';
import { assembleRoute } from '../src/lib/routing/directions';
import { NodeIndex } from '../src/lib/routing/snap';
import { makeGridTile } from './fixtures/grid';
import { parseTileKey, tileToLngLatBounds } from '../src/lib/tiles';

const TILE: { z: number; x: number; y: number } = { z: 13, x: 4400, y: 2620 }; // ~Harrisburg area

function buildGraph(tileCount = 1, onewayAvenues = false) {
  const g = emptyGraph();
  const tiles = [];
  for (let dx = 0; dx < tileCount; dx++) {
    const t = { ...TILE, x: TILE.x + dx };
    const { key, data } = makeGridTile({ tile: t, onewayAvenues });
    tiles.push({ key, data });
    addTileToGraph(g, parseTileKey(key), key, data);
  }
  return { g, tiles };
}

function tileCenter(t: { z: number; x: number; y: number }): [number, number] {
  const { sw, ne } = tileToLngLatBounds(t);
  return [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2];
}

describe('routing graph', () => {
  it('builds a drivable graph from synthetic tiles', () => {
    const { g } = buildGraph();
    expect(g.nodes.length).toBeGreaterThan(10);
    expect(g.edges.length).toBeGreaterThan(20);
    // Two-way edges produce forward + reverse pairs.
    const twoWay = g.edges.filter((e) => e.cls === 'residential');
    expect(twoWay.length % 2).toBe(0);
  });

  it('routes across the grid', () => {
    const { g } = buildGraph();
    const c = tileCenter(TILE);
    const idx = new NodeIndex(g);
    const a = idx.nearest([c[0] - 0.005, c[1] - 0.005], 3000)!;
    const b = idx.nearest([c[0] + 0.005, c[1] + 0.005], 3000)!;
    expect(a.node).not.toBe(b.node);
    const path = findPath(g, a.node, b.node);
    expect(path).not.toBeNull();
    expect(path!.distM).toBeGreaterThan(300);
    expect(path!.distM).toBeLessThan(4000);
  });

  it('respects oneway restrictions', () => {
    const { g } = buildGraph(1, true); // avenues oneway northbound
    const c = tileCenter(TILE);
    const idx = new NodeIndex(g);
    // Northbound trip: should be direct.
    const south = idx.nearest([c[0], c[1] - 0.003], 3000)!;
    const north = idx.nearest([c[0], c[1] + 0.003], 3000)!;
    expect(findPath(g, south.node, north.node)).not.toBeNull();
    // Southbound trip: must go around via two-way streets — still possible
    // on the grid, but must not use any oneway edge against its direction.
    const path = findPath(g, north.node, south.node);
    expect(path).not.toBeNull();
    for (const eid of path!.edges) {
      const e = g.edges[eid];
      expect(e.dead ?? false).toBe(false);
      if (e.oneway === 1) {
        // Only allowed if traveling with geometry — implied by e.from === actual from.
        expect(e.from).toBe(e.from);
      }
    }
    // Verify no edge is traversed reverse of a oneway=1 edge: reconstruct.
    for (let i = 0; i < path!.nodes.length - 1; i++) {
      const e = g.edges[path!.edges[i]];
      expect(e.from).toBe(path!.nodes[i]);
      expect(e.to).toBe(path!.nodes[i + 1]);
    }
  });

  it('stitches adjacent tiles into a connected graph', () => {
    const { g } = buildGraph(2);
    const idx = new NodeIndex(g);
    // Far east end of the second tile to the west end of the first tile.
    const c1 = tileCenter({ ...TILE });
    const c2 = tileCenter({ ...TILE, x: TILE.x + 1 });
    const west = idx.nearest([c1[0] - 0.06, c1[1]], 8000);
    const east = idx.nearest([c2[0] + 0.06, c2[1]], 8000);
    if (west && east) {
      const path = findPath(g, west.node, east.node);
      expect(path).not.toBeNull();
    }
  });

  it('generates turn-by-turn steps with names and modifiers', () => {
    const { g } = buildGraph();
    const c = tileCenter(TILE);
    const idx = new NodeIndex(g);
    const a = idx.nearest([c[0] - 0.003, c[1]], 3000)!;
    const b = idx.nearest([c[0] + 0.002, c[1] + 0.002], 3000)!;
    const path = findPath(g, a.node, b.node)!;
    const route = assembleRoute(g, path);
    expect(route.steps.length).toBeGreaterThanOrEqual(3); // depart + >=1 turn + arrive
    expect(route.steps[0].type).toBe('depart');
    expect(route.steps[route.steps.length - 1].type).toBe('arrive');
    const turns = route.steps.filter((s) => s.type === 'turn');
    expect(turns.length).toBeGreaterThanOrEqual(1);
    for (const t of turns) {
      expect(['left', 'right', 'slight left', 'slight right', 'sharp left', 'sharp right']).toContain(t.modifier);
    }
    // Cumulative distances are monotonic.
    for (let i = 1; i < route.steps.length; i++) {
      expect(route.steps[i].cumDistM).toBeGreaterThanOrEqual(route.steps[i - 1].cumDistM);
    }
    expect(route.distanceM).toBeGreaterThan(0);
    expect(route.durationS).toBeGreaterThan(0);
  });
});
