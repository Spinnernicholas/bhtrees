import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, toPortableValue, fromPortableValue, encodeValue, decodeValue, DocumentError } from '../dist/index.js';

class Point { constructor(x, y) { this.x = x; this.y = y; } }
const codec = { version: 1, test: value => value instanceof Point, encode: value => ({ x: value.x, y: value.y }),
  decode(data) { if (typeof data.x !== 'number' || typeof data.y !== 'number') throw new Error('Invalid coordinates'); return new Point(data.x, data.y); } };
const registry = () => { const r = createRegistry(); r.registerValue('point', codec); return r; };

test('custom values round trip inside ordinary objects and arrays', () => {
  const r = registry();
  const value = { point: new Point(1, 2), list: [null, false, 'text', 42, new Point(3, 4)] };
  const result = decodeValue(encodeValue(value, { registry: r }), { registry: r });
  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual(result.point, new Point(1, 2)); assert.deepEqual(result.list, value.list);
  assert.deepEqual(toPortableValue(result, { registry: r }), toPortableValue(value, { registry: r }));
});

test('ordinary data cannot impersonate a value envelope and special keys are safe', () => {
  const input = JSON.parse('{"kind":"custom","type":"point","version":1,"data":{},"__proto__":42}');
  const result = decodeValue(encodeValue(input));
  assert.equal(result.kind, 'custom'); assert.equal(result.__proto__, 42); assert.equal(Object.getPrototypeOf(result), null);
});

test('old payloads migrate sequentially before decode without mutating their document', () => {
  const old = toPortableValue(new Point(2, 5), { registry: registry() });
  const original = structuredClone(old), r = createRegistry(), visited = [];
  r.registerValue('point', { ...codec, version: 3, encode: p => ({ coordinates: [p.x, p.y] }),
    migrations: {
      1: data => { visited.push(1); return [data.x, data.y]; },
      2: data => { visited.push(2); return { coordinates: data }; }
    }, decode: data => new Point(...data.coordinates)
  });
  assert.deepEqual(fromPortableValue(old, { registry: r }), new Point(2, 5));
  assert.deepEqual(visited, [1, 2]); assert.deepEqual(old, original);
  assert.equal(toPortableValue(new Point(1, 2), { registry: r }).version, 3);
});

test('future versions, missing migrations, and missing codecs fail before decoding', () => {
  const value = toPortableValue(new Point(1, 2), { registry: registry() });
  assert.throws(() => fromPortableValue(value), error => error instanceof DocumentError && error.path === '$.type');
  const r = createRegistry(); let decoded = false;
  r.registerValue('point', { ...codec, version: 2, decode() { decoded = true; return new Point(0, 0); } });
  assert.throws(() => fromPortableValue(value, { registry: r }), /Missing migration/); assert.equal(decoded, false);
  value.version = 3;
  assert.throws(() => fromPortableValue(value, { registry: r }), /Unsupported custom value version/); assert.equal(decoded, false);
});

test('unsupported values are rejected instead of silently changed by JSON', () => {
  for (const value of [undefined, NaN, Infinity, -0, 1n, Symbol('x'), () => {}, new Date(), new Map()]) {
    assert.throws(() => encodeValue({ nested: value }), error => error instanceof DocumentError && error.path === '$["nested"]');
  }
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => encodeValue(cycle), /Cyclic/);
  assert.throws(() => encodeValue(Array(2)), /Sparse/);
  const extra = []; extra.extra = 1; assert.throws(() => encodeValue(extra), /array properties/);
  let read = false;
  assert.throws(() => encodeValue({ get x() { read = true; return 1; } }), /data property/); assert.equal(read, false);
});

test('malformed envelopes, duplicate keys, getters, and size limits are rejected', () => {
  for (const value of [{ kind: 'unknown' }, { kind: 'array', items: [], extra: true },
    { kind: 'array', items: Array(2) }, { kind: 'object', entries: [['x', 1], ['x', 2]] },
    { kind: 'object', entries: [[1, 2]] }, { kind: 'custom', type: 'point', version: 0, data: null }]) {
    assert.throws(() => fromPortableValue(value, { registry: registry() }), DocumentError);
  }
  let read = false;
  assert.throws(() => fromPortableValue({ get kind() { read = true; return 'array'; } }), /data property/); assert.equal(read, false);
  const cycle = { kind: 'array', items: [] }; cycle.items.push(cycle);
  assert.throws(() => fromPortableValue(cycle), /Cyclic/);
  let deep = 1; for (let i = 0; i < 130; i++) deep = [deep];
  assert.throws(() => encodeValue(deep), /limit/);
  assert.throws(() => decodeValue(' '.repeat(1000001)), /1000000/);
});

test('codec failures carry paths and decoded outputs must match their registered type', () => {
  const r = createRegistry(); r.registerValue('point', { ...codec, encode: () => { throw new Error('encode broke'); } });
  assert.throws(() => encodeValue([new Point(1, 2)], { registry: r }), error => error.path === '$[0]' && /encode broke/.test(error.message));
  const bad = createRegistry(); bad.registerValue('point', { ...codec, decode: () => ({}) });
  assert.throws(() => fromPortableValue(toPortableValue(new Point(1, 2), { registry: registry() }), { registry: bad }), /does not match/);
  const recursive = createRegistry(); recursive.registerValue('point', { ...codec, encode: p => p });
  assert.throws(() => encodeValue(new Point(1, 2), { registry: recursive }), /Cyclic/);
});

test('registrations are isolated, copied, ordered, and validate migrations', () => {
  const r = registry(); assert.throws(() => r.registerValue('point', codec), /Duplicate/);
  assert.throws(() => r.registerValue('', codec), /names/);
  assert.throws(() => r.registerValue('bad', { ...codec, version: 0 }), /version/);
  assert.throws(() => r.registerValue('bad', { ...codec, migrations: { 1: data => data } }), /migration/);
  const mutable = { ...codec }; const other = createRegistry(); other.registerValue('point', mutable);
  mutable.encode = () => { throw new Error('changed'); };
  assert.equal(toPortableValue(new Point(1, 2), { registry: other }).type, 'point');
  other.registerValue('second-point', codec);
  assert.equal(toPortableValue(new Point(1, 2), { registry: other }).type, 'point');
});
