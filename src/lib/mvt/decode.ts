/**
 * Minimal Mapbox Vector Tile (v2) decoder — zero dependencies.
 *
 * The tile format is a small protobuf: Tile { repeated Layer layers = 3 },
 * Layer { version=15, name=1, features=2, keys=3, values=4, extent=5 },
 * Feature { id=1, tags=2 (packed), type=3, geometry=4 (packed) }.
 * Geometry commands: MoveTo=1, LineTo=2, ClosePath=7 with zigzag deltas.
 * Deliberately in-house (~150 lines): works identically on the main thread,
 * in Web Workers and in unit tests, and keeps the bundle lean.
 */

export type MvtValue = string | number | boolean;

export interface MvtFeature {
  id?: number;
  /** 1 = point, 2 = line, 3 = polygon. */
  type: number;
  props: Record<string, MvtValue>;
  /** Paths in tile-local coordinates (0..extent). */
  paths: [number, number][];
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE = 7;

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end: number = buf.length) {}

  /** Read a base-128 varint (safe up to 2^53). */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 49) throw new Error('varint too long');
    }
    return result;
  }

  zigzag(): number {
    const n = this.varint();
    return (n >>> 1) ^ -(n & 1);
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) {
      const len = this.varint();
      this.pos += len;
    } else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }

  sub(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    return r;
  }
}

interface Field {
  tag: number;
  wire: number;
}

function nextField(r: Reader): Field | null {
  if (r.pos >= r.end) return null;
  const key = r.varint();
  return { tag: key >>> 3, wire: key & 7 };
}

function readUtf8(r: Reader): string {
  const sub = r.sub();
  return new TextDecoder().decode(sub.buf.subarray(sub.pos, sub.end));
}

function parseValueMsg(r: Reader): MvtValue {
  let out: MvtValue = '';
  let f: Field | null;
  while ((f = nextField(r))) {
    if (f.wire === 2) {
      if (f.tag === 1) out = readUtf8(r);
      else r.skip(f.wire);
    } else if (f.wire === 0) {
      const n = r.varint();
      if (f.tag === 6) out = (n >>> 1) ^ -(n & 1);
      else if (f.tag === 7) out = n !== 0;
      else if (f.tag === 5) out = n; // sint32 stored as varint here — fine for our use
      else out = n;
    } else if (f.wire === 1 && f.tag === 3) {
      const dv = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 8);
      r.pos += 8;
      out = dv.getFloat64(0, true);
    } else if (f.wire === 5 && f.tag === 2) {
      const dv = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 4);
      r.pos += 4;
      out = dv.getFloat32(0, true);
    } else {
      r.skip(f.wire);
    }
  }
  return out;
}

function decodeGeometry(enc: Reader): [number, number][] {
  const pts: [number, number][] = [];
  let x = 0;
  let y = 0;
  while (enc.pos < enc.end) {
    const cmd = enc.varint();
    const id = cmd & 7;
    const count = cmd >> 3;
    if (id === CMD_MOVE_TO || id === CMD_LINE_TO) {
      for (let i = 0; i < count; i++) {
        x += enc.zigzag();
        y += enc.zigzag();
        pts.push([x, y]);
      }
    } else if (id === CMD_CLOSE) {
      if (pts.length > 0) pts.push(pts[0]);
    }
  }
  return pts;
}

function parseFeature(
  r: Reader,
  keys: string[],
  values: MvtValue[],
): MvtFeature {
  let id: number | undefined;
  let type = 0;
  let tags: number[] = [];
  let paths: [number, number][] = [];
  let f: Field | null;
  while ((f = nextField(r))) {
    if (f.tag === 1 && f.wire === 0) id = r.varint();
    else if (f.tag === 2 && f.wire === 2) {
      const sub = r.sub();
      tags = [];
      while (sub.pos < sub.end) tags.push(sub.varint());
    } else if (f.tag === 3 && f.wire === 0) type = r.varint();
    else if (f.tag === 4 && f.wire === 2) {
      const sub = r.sub();
      paths = decodeGeometry(sub);
    } else r.skip(f.wire);
  }
  const props: Record<string, MvtValue> = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const key = keys[tags[i]];
    const val = values[tags[i + 1]];
    if (key !== undefined && val !== undefined) props[key] = val;
  }
  return { id, type, props, paths };
}

function parseLayer(r: Reader): MvtLayer {
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: MvtValue[] = [];
  const rawFeatures: Reader[] = [];
  let f: Field | null;
  // MVT allows keys/values tables to appear after features, so feature
  // parsing is deferred until the whole layer has been consumed.
  while ((f = nextField(r))) {
    if (f.tag === 1 && f.wire === 2) name = readUtf8(r);
    else if (f.tag === 2 && f.wire === 2) rawFeatures.push(r.sub());
    else if (f.tag === 3 && f.wire === 2) keys.push(readUtf8(r));
    else if (f.tag === 4 && f.wire === 2) values.push(parseValueMsg(r.sub()));
    else if (f.tag === 5 && f.wire === 0) extent = r.varint();
    else r.skip(f.wire);
  }
  const features = rawFeatures.map((fr) => parseFeature(fr, keys, values));
  return { name, extent, features };
}

export function readMvt(data: ArrayBuffer | Uint8Array): MvtLayer[] {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const r = new Reader(buf);
  const layers: MvtLayer[] = [];
  let f: Field | null;
  while ((f = nextField(r))) {
    if (f.tag === 3 && f.wire === 2) layers.push(parseLayer(r.sub()));
    else r.skip(f.wire);
  }
  return layers;
}
