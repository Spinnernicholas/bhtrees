import { DocumentError } from './document-error.js';
import type { TreeRegistry, SerializationOptions } from './serialization.js';

export interface ValueCodec<T> {
  version: number;
  test(value: unknown): value is T;
  encode(value: T): unknown;
  decode(data: unknown): T;
  /** Each entry upgrades that version's decoded payload to the next version. */
  migrations?: Readonly<Record<number, (data: unknown) => unknown>>;
}
export type PortableValue = null | boolean | string | number |
  { kind: 'array'; items: PortableValue[] } |
  { kind: 'object'; entries: [string, PortableValue][] } |
  { kind: 'custom'; type: string; version: number; data: PortableValue };

// Codec callbacks are type-erased internally after registration validation.
type RegisteredCodec = ValueCodec<any>;
const registries = new WeakMap<TreeRegistry, Map<string, RegisteredCodec>>();
export function attachValueRegistry(registry: TreeRegistry) { registries.set(registry, new Map()); }
export function registerValueType<T>(registry: TreeRegistry, name: string, codec: ValueCodec<T>) {
  if (typeof name !== 'string' || !name) throw new TypeError('Value type names must be nonempty strings');
  if (!codec || !Number.isSafeInteger(codec.version) || codec.version < 1) throw new TypeError('Value codec version must be a positive safe integer');
  if (typeof codec.test !== 'function' || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') throw new TypeError('Value codecs require test, encode, and decode functions');
  const migrations = { ...codec.migrations };
  for (const [key, migrate] of Object.entries(migrations)) {
    const version = Number(key);
    if (!Number.isSafeInteger(version) || version < 1 || version >= codec.version || String(version) !== key || typeof migrate !== 'function') throw new TypeError('Invalid value migration');
  }
  const entries = registries.get(registry);
  if (!entries) throw new TypeError('Invalid registry');
  if (entries.has(name)) throw new TypeError(`Duplicate value type: ${name}`);
  entries.set(name, Object.freeze({ version: codec.version, test: codec.test, encode: codec.encode, decode: codec.decode,
    migrations: Object.freeze(migrations) }));
}
function fail(path: string, message: string): never { throw new DocumentError(path, message); }
function entries(registry?: TreeRegistry) {
  if (!registry) return new Map<string, RegisteredCodec>();
  const result = registries.get(registry);
  if (!result) fail('$registry', 'Expected a registry created by createRegistry');
  return result;
}
function callback<T>(path: string, name: string, fn: () => T): T {
  try { return fn(); } catch (error) { fail(path, `${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function own(value: object, key: PropertyKey, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) fail(path, 'Expected an own data property');
  return descriptor.value;
}
const MAX_DEPTH = 128, MAX_VALUES = 100000, MAX_TEXT = 1000000;
function bounds() {
  let count = 0;
  return (depth: number, path: string) => {
    if (depth > MAX_DEPTH || ++count > MAX_VALUES) fail(path, 'Value depth or size limit exceeded');
  };
}

/** All containers are tagged, so ordinary data cannot impersonate a custom envelope. */
export function toPortableValue(value: unknown, { registry }: SerializationOptions = {}): PortableValue {
  const codecs = entries(registry), active = new Set<unknown>(), check = bounds();
  function encode(value: unknown, path: string, depth: number): PortableValue {
    check(depth, path);
    if (active.has(value)) fail(path, 'Cyclic value or codec payload');
    active.add(value);
    try {
      for (const [name, codec] of codecs) {
        const matches = callback(path, `Value test ${name} failed`, () => codec.test(value));
        if (typeof matches !== 'boolean') fail(path, `Value test ${name} must return a boolean`);
        if (matches) {
          const payload = callback(path, `Value encoder ${name} failed`, () => codec.encode(value));
          return { kind: 'custom', type: name, version: codec.version, data: encode(payload, `${path}.data`, depth + 1) };
        }
      }
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
      if (!value || typeof value !== 'object') fail(path, `Unsupported unregistered value: ${typeof value}`);
      if (Array.isArray(value)) {
        if (Reflect.ownKeys(value).length !== value.length + 1) fail(path, 'Sparse arrays and extra array properties are unsupported');
        const items: PortableValue[] = [];
        for (let i = 0; i < value.length; i++) items.push(encode(own(value, String(i), `${path}[${i}]`), `${path}[${i}]`, depth + 1));
        return { kind: 'array', items };
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'Unregistered object type');
      const pairs: [string, PortableValue][] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') fail(path, 'Symbol keys are unsupported');
        const field = `${path}[${JSON.stringify(key)}]`;
        pairs.push([key, encode(own(value, key, field), field, depth + 1)]);
      }
      return { kind: 'object', entries: pairs };
    } finally { active.delete(value); }
  }
  return encode(value, '$', 0);
}

export function fromPortableValue(value: unknown, { registry }: SerializationOptions = {}): unknown {
  const codecs = entries(registry), active = new Set<object>(), check = bounds();
  function decode(value: unknown, path: string, depth: number): unknown {
    check(depth, path);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'Invalid portable value');
    if (active.has(value)) fail(path, 'Cyclic portable value');
    active.add(value);
    try {
      const kind = own(value, 'kind', `${path}.kind`);
      const allowed = kind === 'array' ? ['kind', 'items'] : kind === 'object' ? ['kind', 'entries'] : kind === 'custom' ? ['kind', 'type', 'version', 'data'] : [];
      if (!allowed.length) fail(`${path}.kind`, 'Unknown value envelope');
      for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !allowed.includes(key)) fail(path, 'Unknown envelope field');
      if (kind === 'custom') {
        const name = own(value, 'type', `${path}.type`), version = own(value, 'version', `${path}.version`);
        if (typeof name !== 'string' || !codecs.has(name)) fail(`${path}.type`, 'Unknown custom value type');
        const codec = codecs.get(name)!;
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > codec.version) fail(`${path}.version`, 'Unsupported custom value version');
        if (codec.version - version > MAX_DEPTH) fail(`${path}.version`, 'Too many migration steps');
        for (let v = version; v < codec.version; v++) if (!codec.migrations?.[v]) fail(`${path}.version`, `Missing migration from version ${v}`);
        let data = decode(own(value, 'data', `${path}.data`), `${path}.data`, depth + 1);
        for (let v = version; v < codec.version; v++) data = callback(path, `Migration ${name} v${v} failed`, () => codec.migrations![v](data));
        const result = callback(path, `Value decoder ${name} failed`, () => codec.decode(data));
        if (callback(path, `Value test ${name} failed`, () => codec.test(result)) !== true) fail(path, `Decoded value does not match ${name}`);
        return result;
      }
      const field = kind === 'array' ? 'items' : 'entries';
      const list = own(value, field, `${path}.${field}`);
      if (!Array.isArray(list) || list.length > MAX_VALUES || Reflect.ownKeys(list).length !== list.length + 1) fail(`${path}.${field}`, 'Expected a dense array');
      const result: Record<string, unknown> = Object.create(null);
      const items: unknown[] = [];
      for (let i = 0; i < list.length; i++) {
        const location = `${path}.${field}[${i}]`, item = own(list, String(i), location);
        if (kind === 'array') items.push(decode(item, location, depth + 1));
        else {
          if (!Array.isArray(item) || item.length !== 2 || Reflect.ownKeys(item).length !== 3) fail(location, 'Expected a key/value pair');
          const key = own(item, '0', location), data = own(item, '1', location);
          if (typeof key !== 'string' || Object.hasOwn(result, key)) fail(location, 'Expected a unique string key');
          result[key] = decode(data, `${location}[1]`, depth + 1);
        }
      }
      return kind === 'array' ? items : result;
    } finally { active.delete(value); }
  }
  return decode(value, '$', 0);
}
export function encodeValue(value: unknown, options: SerializationOptions = {}): string {
  const text = JSON.stringify(toPortableValue(value, options));
  if (text.length > MAX_TEXT) fail('$', 'Value text exceeds 1000000 characters');
  return text;
}
export function decodeValue(text: string, options: SerializationOptions = {}): unknown {
  if (typeof text !== 'string' || text.length > MAX_TEXT) fail('$', 'Expected value JSON text of at most 1000000 characters');
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { fail('$', `Invalid JSON: ${(error as Error).message}`); }
  return fromPortableValue(value, options);
}
