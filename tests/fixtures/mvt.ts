/**
 * Minimal Mapbox Vector Tile ENCODER for test fixtures.
 * Inverse of src/lib/mvt/decode.ts, dependency-free.
 */

export interface TestFeature {
  props: Record<string, string | number | boolean>;
  /** Flat [x,y] tile-local coordinates (extent space). */
  points: [number, number][];
  /** 1 = point, 2 = line. */
  type: 1 | 2;
}

class Buf {
  arr: number[] = [];
  varint(v: number): this {
    let x = v;
    do {
      let b = x & 0x7f;
      x = Math.floor(x / 128);
      if (x > 0) b |= 0x80;
      this.arr.push(b);
    } while (x > 0);
    return this;
  }
  key(field: number, wire: number): this {
    return this.varint((field << 3) | wire);
  }
  str(s: string): this {
    const bytes = Array.from(new TextEncoder().encode(s));
    this.varint(bytes.length);
    this.arr.push(...bytes);
    return this;
  }
  msg(field: number, fn: (b: Buf) => void): this {
    const inner = new Buf();
    fn(inner);
    this.key(field, 2);
    this.varint(inner.arr.length);
    this.arr.push(...inner.arr);
    return this;
  }
}

const zz = (n: number): number => (n << 1) ^ (n >> 31);

function encodeValue(b: Buf, v: string | number | boolean): void {
  if (typeof v === 'string') {
    b.key(1, 2);
    b.str(v);
  } else if (typeof v === 'boolean') {
    b.key(7, 0);
    b.varint(v ? 1 : 0);
  } else if (Number.isInteger(v)) {
    b.key(6, 0);
    b.varint(zz(v));
  } else {
    b.key(3, 1);
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) b.arr.push(dv.getUint8(i));
  }
}

function encodeFeature(f: TestFeature, keys: string[], values: (string | number | boolean)[]): Buf {
  const b = new Buf();
  // id
  b.key(1, 0);
  b.varint(1);
  // tags
  const tags = new Buf();
  for (const [k, v] of Object.entries(f.props)) {
    let ki = keys.indexOf(k);
    if (ki < 0) {
      ki = keys.length;
      keys.push(k);
    }
    let vi = values.findIndex((x) => x === v && typeof x === typeof v);
    if (vi < 0) {
      vi = values.length;
      values.push(v);
    }
    tags.varint(ki);
    tags.varint(vi);
  }
  b.key(2, 2);
  b.varint(tags.arr.length);
  b.arr.push(...tags.arr);
  // type
  b.key(3, 0);
  b.varint(f.type);
  // geometry
  const geom = new Buf();
  if (f.type === 1) {
    geom.varint(1 | (f.points.length << 3));
    let px = 0;
    let py = 0;
    for (const [x, y] of f.points) {
      geom.varint(zz(x - px));
      geom.varint(zz(y - py));
      px = x;
      py = y;
    }
  } else {
    // Single line: MoveTo(first) + LineTo(rest).
    geom.varint(1 | (1 << 3));
    geom.varint(zz(f.points[0][0]));
    geom.varint(zz(f.points[0][1]));
    geom.varint(2 | ((f.points.length - 1) << 3));
    let [px, py] = f.points[0];
    for (let i = 1; i < f.points.length; i++) {
      geom.varint(zz(f.points[i][0] - px));
      geom.varint(zz(f.points[i][1] - py));
      px = f.points[i][0];
      py = f.points[i][1];
    }
  }
  b.key(4, 2);
  b.varint(geom.arr.length);
  b.arr.push(...geom.arr);
  return b;
}

export function encodeTile(
  layers: { name: string; extent?: number; features: TestFeature[] }[],
): ArrayBuffer {
  const tile = new Buf();
  for (const layer of layers) {
    const extent = layer.extent ?? 4096;
    const keys: string[] = [];
    const values: (string | number | boolean)[] = [];
    const featureBufs = layer.features.map((f) => encodeFeature(f, keys, values));
    tile.msg(3, (l) => {
      l.key(15, 0);
      l.varint(2); // version
      l.key(1, 2);
      l.str(layer.name);
      for (const fb of featureBufs) {
        l.key(2, 2);
        l.varint(fb.arr.length);
        l.arr.push(...fb.arr);
      }
      for (const k of keys) {
        l.key(3, 2);
        l.str(k);
      }
      for (const v of values) {
        l.msg(4, (vb) => encodeValue(vb, v));
      }
      l.key(5, 0);
      l.varint(extent);
    });
  }
  return new Uint8Array(tile.arr).buffer;
}
