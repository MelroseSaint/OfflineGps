import { describe, expect, it } from 'vitest';
import { extractSearchDocs } from '../src/lib/search/extract';
import { makeGridTile } from './fixtures/grid';

const TILE_SEARCH = { z: 13, x: 4400, y: 2620 };

describe('search extraction', () => {
  it('extracts places and streets from a tile', () => {
    const { key, data } = makeGridTile({ tile: TILE_SEARCH, n: 4 });
    const docs = extractSearchDocs(key, data);
    const places = docs.filter((d) => d.kind === 'city' || d.kind === 'suburb');
    const streets = docs.filter((d) => d.kind === 'street');
    expect(places.map((d) => d.name)).toContain('Harrisburg');
    expect(streets.length).toBeGreaterThan(0);
    expect(streets[0].norm).toBe(streets[0].name.toLowerCase());
    // All docs tagged with their tile for eviction.
    expect(docs.every((d) => d.tile === key)).toBe(true);
  });
});
