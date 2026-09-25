import { DocumentError } from './document-error.js';
import { parseYaml, stringifyYaml } from './yaml.js';
import type { YamlValue } from './yaml.js';

export type ExtensionDeclaration = {
  id?: string;
  enabled?: boolean;
  options?: Record<string, YamlValue>;
} & ({ name: string; path?: never } | { path: string; name?: never });
export type ResolvedExtension = Readonly<{
  id: string;
  enabled: boolean;
  options: Readonly<Record<string, YamlValue>>;
} & ({ name: string; path?: never } | { path: string; name?: never })>;
export interface Configuration {
  runtime?: { maxStepsPerTick?: number; errorPolicy?: 'stop' };
  blackboard?: { enabled?: boolean; initial?: Record<string, YamlValue> };
  extensions?: ExtensionDeclaration[];
}
export interface ConfigDocument {
  format: 'bhtrees'; version: 1; kind: 'config'; config: Configuration;
}
export interface ConfigCodecOptions { codec?: 'json' | 'yaml' }
export interface ConfigSource { layer: string; uri?: string }
export interface ConfigLayer { config: Configuration; source: ConfigSource }
export interface ResolvedConfiguration {
  readonly config: {
    readonly runtime: { readonly maxStepsPerTick: number; readonly errorPolicy: 'stop' };
    readonly blackboard: { readonly enabled: boolean; readonly initial: Readonly<Record<string, YamlValue>> };
    readonly extensions: readonly ResolvedExtension[];
  };
  /** JSON Pointer paths to effective leaves (including arrays and empty objects). */
  readonly provenance: Readonly<Record<string, Readonly<ConfigSource>>>;
}
const MAX_TEXT = 1000000;
const MAX_EXTENSIONS = 1000;
function fail(path: string, message: string): never { throw new DocumentError(path, message); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(path, 'Expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) fail(path, 'Expected string-keyed data properties');
  }
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.getOwnPropertyNames(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'Unknown configuration field');
}
function nonempty(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) return fail(path, 'Expected a nonempty string');
  return value;
}
export function validateConfigURI(value: string, path: string): void {
  try {
    if (typeof value !== 'string' || /^[a-zA-Z]:[\\/]/.test(value) || value.includes('\\')) throw Error('Use a URI');
    new URL(value);
  } catch { fail(path, 'Expected an absolute base URI; use file URLs for filesystem paths'); }
}
export function resolveConfigURI(reference: string, baseURI: string | undefined, path: string): string {
  if (baseURI !== undefined) validateConfigURI(baseURI, path);
  try {
    if (/^[a-zA-Z]:[\\/]/.test(reference) || reference.includes('\\')) throw Error('Use a URI');
    return new URL(reference, baseURI).href;
  } catch { return fail(path, 'Relative reference requires an absolute declaring URI; use file URLs for filesystem paths'); }
}
/** Copy plain data without accessing getters, preserving special keys safely. */
export function copyConfigValue(value: unknown, path = '$'): YamlValue {
  const active = new Set<object>(); let count = 0;
  function copy(value: unknown, path: string, depth: number): YamlValue {
    if (depth > 128 || ++count > 100000) return fail(path, 'Configuration depth or size limit exceeded');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== 'object') return fail(path, 'Expected portable configuration data');
    if (active.has(value)) return fail(path, 'Cyclic configuration');
    active.add(value);
    let result: YamlValue;
    if (Array.isArray(value)) {
      if (value.length > 100000 || Reflect.ownKeys(value).length !== value.length + 1) return fail(path, 'Invalid configuration array');
      result = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !('value' in descriptor)) return fail(`${path}[${i}]`, 'Expected an array data property');
        result.push(copy(descriptor.value, `${path}[${i}]`, depth + 1));
      }
    } else {
      const record = object(value, path), output: Record<string, YamlValue> = Object.create(null);
      for (const key of Object.getOwnPropertyNames(record)) output[key] = copy(record[key], `${path}[${JSON.stringify(key)}]`, depth + 1);
      result = output;
    }
    active.delete(value); return result;
  }
  return copy(value, path, 0);
}
export function validateConfiguration(value: unknown, path = '$.config'): Configuration {
  const input = object(value, path);
  fields(input, ['runtime', 'blackboard', 'extensions'], path);
  const result: Configuration = {};
  if (Object.hasOwn(input, 'runtime')) {
    const runtime = object(input.runtime, `${path}.runtime`);
    fields(runtime, ['maxStepsPerTick', 'errorPolicy'], `${path}.runtime`);
    result.runtime = {};
    if (Object.hasOwn(runtime, 'maxStepsPerTick')) {
      const budget = runtime.maxStepsPerTick;
      if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 1) fail(`${path}.runtime.maxStepsPerTick`, 'Expected a positive safe integer');
      result.runtime.maxStepsPerTick = budget as number;
    }
    if (Object.hasOwn(runtime, 'errorPolicy')) {
      if (runtime.errorPolicy !== 'stop') fail(`${path}.runtime.errorPolicy`, 'Only stop is supported');
      result.runtime.errorPolicy = 'stop';
    }
  }
  if (Object.hasOwn(input, 'blackboard')) {
    const blackboard = object(input.blackboard, `${path}.blackboard`);
    fields(blackboard, ['enabled', 'initial'], `${path}.blackboard`);
    result.blackboard = {};
    if (Object.hasOwn(blackboard, 'enabled')) {
      if (typeof blackboard.enabled !== 'boolean') fail(`${path}.blackboard.enabled`, 'Expected a boolean');
      result.blackboard.enabled = blackboard.enabled as boolean;
    }
    if (Object.hasOwn(blackboard, 'initial')) {
      object(blackboard.initial, `${path}.blackboard.initial`);
      result.blackboard.initial = copyConfigValue(blackboard.initial, `${path}.blackboard.initial`) as Record<string, YamlValue>;
    }
  }
  if (Object.hasOwn(input, 'extensions')) {
    const at = `${path}.extensions`, value = input.extensions;
    if (!Array.isArray(value) || value.length > MAX_EXTENSIONS) return fail(at, 'Expected at most 1000 extension declarations');
    // Copy first to reject sparse arrays, accessors, symbols and unsupported option data.
    const declarations = copyConfigValue(value, at) as Record<string, YamlValue>[];
    const identities = new Set<string>();
    result.extensions = declarations.map((value, index) => {
      const location = `${at}[${index}]`, declaration = object(value, location);
      fields(declaration, ['id', 'name', 'path', 'enabled', 'options'], location);
      const named = Object.hasOwn(declaration, 'name'), located = Object.hasOwn(declaration, 'path');
      if (named === located) fail(location, 'Extension requires exactly one of name or path');
      const key = named ? 'name' : 'path', target = nonempty(declaration[key], `${location}.${key}`);
      const id = Object.hasOwn(declaration, 'id') ? nonempty(declaration.id, `${location}.id`) : target;
      const identity = JSON.stringify([!named && !Object.hasOwn(declaration, 'id') ? 'path' : 'id', id]);
      if (identities.has(identity)) fail(`${location}.id`, `Duplicate extension ID in one source: ${id}`);
      identities.add(identity);
      if (Object.hasOwn(declaration, 'enabled') && typeof declaration.enabled !== 'boolean') fail(`${location}.enabled`, 'Expected a boolean');
      if (Object.hasOwn(declaration, 'options')) object(declaration.options, `${location}.options`);
      return declaration as ExtensionDeclaration;
    });
  }
  return result;
}
export function toConfigDocument(config: Configuration): ConfigDocument {
  return { format: 'bhtrees', version: 1, kind: 'config', config: validateConfiguration(config) };
}
export function fromConfigDocument(value: unknown): Configuration {
  const document = object(value, '$'); fields(document, ['format', 'version', 'kind', 'config'], '$');
  if (document.format !== 'bhtrees') fail('$.format', 'Expected bhtrees');
  if (document.version !== 1) fail('$.version', 'Unsupported schema version; expected 1');
  if (document.kind !== 'config') fail('$.kind', 'Expected config');
  return validateConfiguration(document.config);
}
export function parseDocumentText(text: string, { codec = 'json' }: ConfigCodecOptions = {}): unknown {
  if (codec === 'yaml') return parseYaml(text);
  if (codec !== 'json') fail('$codec', 'Unsupported codec');
  if (typeof text !== 'string' || text.length > MAX_TEXT) fail('$', 'Expected JSON text of at most 1000000 characters');
  try { return JSON.parse(text); } catch (error) { return fail('$', `Invalid JSON: ${(error as Error).message}`); }
}
export function encodeConfig(config: Configuration, { codec = 'json' }: ConfigCodecOptions = {}): string {
  if (codec !== 'json' && codec !== 'yaml') fail('$codec', 'Unsupported codec');
  const document = toConfigDocument(config);
  if (codec === 'yaml') return stringifyYaml(document);
  const text = JSON.stringify(document, null, 2);
  if (text.length > MAX_TEXT) fail('$', 'Configuration text exceeds 1000000 characters');
  return text;
}
export function decodeConfig(text: string, options: ConfigCodecOptions = {}): Configuration {
  return fromConfigDocument(parseDocumentText(text, options));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const isRecord = (value: unknown): value is Record<string, YamlValue> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Merge low-to-high priority layers over immutable library defaults. */
export function resolveConfiguration(layers: readonly ConfigLayer[] = []): ResolvedConfiguration {
  if (!Array.isArray(layers) || layers.length > 128) fail('$layers', 'Expected at most 128 configuration layers');
  const merged: Record<string, YamlValue> = Object.create(null);
  const provenance: Record<string, ConfigSource> = Object.create(null);
  const defaults: ConfigLayer = { config: { runtime: { maxStepsPerTick: 1000, errorPolicy: 'stop' }, blackboard: { enabled: false, initial: {} } }, source: { layer: 'defaults' } };
  const extensions: Record<string, YamlValue>[] = [];
  const extensionIndex = new Map<string, number>();
  provenance['/extensions'] = { layer: 'defaults' };
  function mark(value: YamlValue, path: string, source: ConfigSource) {
    if (isRecord(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) mark(child, `${path}/${pointer(key)}`, source);
    } else provenance[path] = source;
  }
  function unmark(value: YamlValue, path: string) {
    delete provenance[path];
    if (isRecord(value)) for (const [key, child] of Object.entries(value)) unmark(child, `${path}/${pointer(key)}`);
  }
  function merge(target: Record<string, YamlValue>, patch: Record<string, YamlValue>, path: string, source: ConfigSource) {
    for (const [key, value] of Object.entries(patch)) {
      const at = `${path}/${pointer(key)}`;
      if (isRecord(value) && Object.hasOwn(target, key) && isRecord(target[key])) {
        if (Object.keys(value).length) delete provenance[at];
        merge(target[key], value, at, source);
      } else {
        if (Object.hasOwn(target, key)) unmark(target[key], at);
        target[key] = value; mark(value, at, source);
      }
    }
  }
  for (const [index, layer] of [defaults, ...layers].entries()) {
    const path = `$layers[${index - 1}]`;
    const input = object(layer, path); fields(input, ['config', 'source'], path);
    const origin = object(input.source, `${path}.source`); fields(origin, ['layer', 'uri'], `${path}.source`);
    if (typeof origin.layer !== 'string' || !origin.layer) fail(`${path}.source.layer`, 'Expected a nonempty source label');
    if (Object.hasOwn(origin, 'uri') && (typeof origin.uri !== 'string' || !origin.uri)) fail(`${path}.source.uri`, 'Expected a nonempty URI');
    const source = { layer: origin.layer as string, ...(origin.uri === undefined ? {} : { uri: origin.uri as string }) };
    const { extensions: declarations, ...configuration } = validateConfiguration(input.config, `${path}.config`);
    merge(merged, configuration as Record<string, YamlValue>, '', source);
    const identities = new Set<string>();
    for (const [declarationIndex, declaration] of (declarations ?? []).entries()) {
      const at = `${path}.config.extensions[${declarationIndex}]`;
      const resolvedPath = declaration.path === undefined ? undefined : resolveConfigURI(declaration.path, source.uri, `${at}.path`);
      const id = declaration.id ?? declaration.name ?? resolvedPath!;
      if (identities.has(id)) fail(`${at}.id`, `Duplicate resolved extension ID in one source: ${id}`);
      identities.add(id);
      const previous = extensionIndex.get(id);
      if (previous !== undefined) {
        const entry = extensions[previous];
        if (entry.name !== declaration.name || entry.path !== resolvedPath) fail(`${at}.id`, `Conflicting extension source for ID: ${id}`);
        merge(entry, { ...(resolvedPath === undefined ? { name: declaration.name! } : { path: resolvedPath }),
          ...(declaration.id === undefined ? {} : { id }),
          ...(declaration.enabled === undefined ? {} : { enabled: declaration.enabled }),
          ...(declaration.options === undefined ? {} : { options: declaration.options }) }, `/extensions/${previous}`, source);
      } else {
        if (extensions.length >= MAX_EXTENSIONS) fail(at, 'Too many resolved extensions');
        const entry: Record<string, YamlValue> = { id, ...(resolvedPath === undefined ? { name: declaration.name! } : { path: resolvedPath }),
          enabled: declaration.enabled ?? true, options: declaration.options ?? Object.create(null) };
        const position = extensions.length;
        extensionIndex.set(id, position); extensions.push(entry);
        delete provenance['/extensions'];
        mark(entry, `/extensions/${position}`, source);
        if (declaration.enabled === undefined) provenance[`/extensions/${position}/enabled`] = { layer: 'defaults' };
        if (declaration.options === undefined) provenance[`/extensions/${position}/options`] = { layer: 'defaults' };
      }
    }
  }
  // Bound the aggregate as well as each individual layer.
  const config = validateConfiguration({ ...merged, extensions }) as ResolvedConfiguration['config'];
  return freeze({ config, provenance });
}
