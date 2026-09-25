import { forkRegistry } from './serialization.js';
import type { TreeRegistry } from './serialization.js';
import { resolveConfiguration } from './config.js';
import type { ExtensionDeclaration, ResolvedExtension } from './config.js';
import type { YamlValue } from './yaml.js';
import type { ValueCodec } from './values.js';

export type ExtensionDisposer = () => void | Promise<void>;
export interface ExtensionAPI extends TreeRegistry {
  registerService(name: string, value: unknown): void;
  getService(name: string): unknown;
  /** Register immediately after acquiring a resource, including during partial setup. */
  onDispose(dispose: ExtensionDisposer): void;
}
export interface ExtensionManifest {
  id: string;
  version: string;
  apiVersion: 1;
  /** Catalog names / manifest IDs, without version ranges. */
  dependencies?: readonly string[];
  validateOptions?: (options: Readonly<Record<string, YamlValue>>) => void | Promise<void>;
  setup(api: ExtensionAPI, options: Readonly<Record<string, YamlValue>>):
    void | { dispose: ExtensionDisposer } | Promise<void | { dispose: ExtensionDisposer }>;
}
export interface ExtensionLoaderOptions {
  builtins?: Readonly<Record<string, ExtensionManifest>>;
  catalog?: Readonly<Record<string, ExtensionManifest | string>>;
  /** Return a manifest or an ESM namespace with a default manifest. */
  importModule?: (uri: string) => unknown | Promise<unknown>;
  allowModule?: (uri: string) => boolean | Promise<boolean>;
}
export interface ExtensionSnapshot {
  readonly id: string;
  readonly declarationId: string;
  readonly version: string;
  readonly location: string;
  readonly dependencies: readonly string[];
  readonly status: 'ready' | 'disposed';
}
export interface ExtensionSession {
  readonly registry: TreeRegistry;
  readonly services: Readonly<Record<string, unknown>>;
  snapshot(): readonly ExtensionSnapshot[];
  dispose(): Promise<void>;
}
export interface ExtensionLoader {
  load(declarations: readonly ExtensionDeclaration[], options?: { registry?: TreeRegistry }): Promise<ExtensionSession>;
}
export class ExtensionError extends Error {
  constructor(public readonly declarationId: string, public readonly location: string,
    public readonly stage: string, cause: unknown) {
    super(`Extension ${declarationId} (${location}) ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ExtensionError';
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected a plain record');
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) throw new TypeError('Expected string-keyed data properties');
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && !!value.trim(); }
function manifest(value: unknown): Readonly<ExtensionManifest> {
  const input = record(value);
  for (const key of Object.getOwnPropertyNames(input)) if (!['id', 'version', 'apiVersion', 'dependencies', 'validateOptions', 'setup'].includes(key)) throw new TypeError(`Unknown manifest field: ${key}`);
  if (!nonempty(input.id) || !nonempty(input.version) || input.apiVersion !== 1 || typeof input.setup !== 'function') throw new TypeError('Manifest requires id, version, apiVersion: 1, and setup');
  if (input.validateOptions !== undefined && typeof input.validateOptions !== 'function') throw new TypeError('Invalid option validator');
  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 1000 || Reflect.ownKeys(dependencies).length !== dependencies.length + 1) throw new TypeError('Expected at most 1000 dependencies');
  const copied: string[] = [];
  for (let i = 0; i < dependencies.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(dependencies, String(i));
    if (!entry || !('value' in entry) || !nonempty(entry.value) || copied.includes(entry.value)) throw new TypeError('Expected unique dependency names');
    copied.push(entry.value);
  }
  return Object.freeze({ id: input.id, version: input.version, apiVersion: 1, dependencies: Object.freeze(copied),
    setup: input.setup as ExtensionManifest['setup'],
    ...(input.validateOptions === undefined ? {} : { validateOptions: input.validateOptions as ExtensionManifest['validateOptions'] }) });
}
function absolute(uri: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(uri) || uri.includes('\\')) throw new TypeError('Use absolute URIs, including file URLs for filesystem paths');
  return new URL(uri).href;
}

/** The host supplies catalogs and module access; the core performs no implicit imports. */
export function createExtensionLoader(options: ExtensionLoaderOptions = {}): ExtensionLoader {
  const builtins = new Map<string, Readonly<ExtensionManifest>>();
  const catalog = new Map<string, Readonly<ExtensionManifest> | string>();
  for (const [name, value] of Object.entries(record(options.builtins ?? {}))) {
    if (!nonempty(name)) throw new TypeError('Invalid catalog name');
    builtins.set(name, manifest(value));
  }
  for (const [name, value] of Object.entries(record(options.catalog ?? {}))) {
    if (!nonempty(name) || builtins.has(name)) throw new TypeError(`Reserved or invalid catalog name: ${name}`);
    catalog.set(name, typeof value === 'string' ? absolute(value) : manifest(value));
  }
  const { importModule, allowModule } = options;
  if (importModule !== undefined && typeof importModule !== 'function') throw new TypeError('Invalid module importer');
  if (allowModule !== undefined && typeof allowModule !== 'function') throw new TypeError('Invalid module policy');
  const cache = new Map<string, Promise<Readonly<ExtensionManifest>>>();
  async function moduleAt(uri: string): Promise<Readonly<ExtensionManifest>> {
    if (allowModule && await allowModule(uri) !== true) throw new Error('Module denied by host policy');
    if (!importModule) throw new Error('A host importModule callback is required');
    let pending = cache.get(uri);
    if (!pending) {
      pending = Promise.resolve().then(() => importModule(uri)).then(value => manifest(
        value && typeof value === 'object' && 'default' in value ? (value as { default: unknown }).default : value));
      cache.set(uri, pending);
    }
    try { return await pending; }
    catch (error) { if (cache.get(uri) === pending) cache.delete(uri); throw error; }
  }
  return Object.freeze({
    async load(declarations: readonly ExtensionDeclaration[], { registry: seed }: { registry?: TreeRegistry } = {}): Promise<ExtensionSession> {
      if (!Array.isArray(declarations) || declarations.length > 1000) throw new TypeError('Expected at most 1000 declarations');
      const registry = forkRegistry(seed);
      const resolved = resolveConfiguration([{ config: { extensions: [...declarations] }, source: { layer: 'extensions' } }]).config.extensions;
      type Entry = { declaration: ResolvedExtension; manifest: Readonly<ExtensionManifest>; location: string };
      const entries = new Map<string, Entry>(), disabled = new Set<string>();
      for (const declaration of resolved) if (!declaration.enabled) {
        disabled.add(declaration.id); if (declaration.name !== undefined) disabled.add(declaration.name);
      }
      async function acquire(declaration: ResolvedExtension): Promise<Entry> {
        let location = declaration.path ?? `catalog:${declaration.name}`;
        try {
          let loaded: Readonly<ExtensionManifest>;
          if (declaration.path !== undefined) loaded = await moduleAt(declaration.path);
          else {
            const builtin = builtins.get(declaration.name!);
            const target = builtin ?? catalog.get(declaration.name!);
            if (!target) throw new Error(`Unknown extension name: ${declaration.name}`);
            if (builtin) location = `builtin:${declaration.name}`;
            if (typeof target === 'string') { location = target; loaded = await moduleAt(target); }
            else loaded = target;
            if (loaded.id !== declaration.name) throw new Error(`Catalog name does not match manifest ID: ${loaded.id}`);
          }
          if (entries.has(loaded.id)) throw new Error(`Conflicting manifest identity: ${loaded.id}`);
          if (entries.size >= 1000) throw new Error('Too many extensions including dependencies');
          const entry = { declaration, manifest: loaded, location }; entries.set(loaded.id, entry); return entry;
        } catch (error) { throw new ExtensionError(declaration.id, location, 'resolution failed', error); }
      }
      for (const declaration of resolved) if (declaration.enabled) await acquire(declaration);
      const ordered: Entry[] = [], active = new Set<string>(), visited = new Set<string>();
      async function visit(entry: Entry, depth: number): Promise<void> {
        const id = entry.manifest.id;
        if (depth > 128 || active.has(id)) throw new ExtensionError(entry.declaration.id, entry.location, 'dependency validation failed', new Error('Dependency cycle or depth limit exceeded'));
        if (visited.has(id)) return;
        active.add(id);
        for (const name of entry.manifest.dependencies!) {
          if (disabled.has(name)) throw new ExtensionError(entry.declaration.id, entry.location, 'dependency validation failed', new Error(`Dependency is explicitly disabled: ${name}`));
          const dependency = entries.get(name) ?? await acquire(Object.freeze({ id: name, name, enabled: true, options: Object.freeze({}) }));
          await visit(dependency, depth + 1);
        }
        active.delete(id); visited.add(id); ordered.push(entry);
      }
      for (const entry of [...entries.values()]) await visit(entry, 0);
      for (const entry of ordered) {
        try {
          if (entry.manifest.validateOptions) await entry.manifest.validateOptions(entry.declaration.options);
          else if (Object.keys(entry.declaration.options).length) throw new Error('Extension does not declare an option validator');
        } catch (error) { throw new ExtensionError(entry.declaration.id, entry.location, 'option validation failed', error); }
      }
      const services: Record<string, unknown> = Object.create(null);
      const disposers: ExtensionDisposer[] = [];
      let disposed = false, disposal: Promise<void> | undefined;
      function dispose(): Promise<void> {
        if (!disposal) {
          disposed = true;
          disposal = Promise.resolve().then(async () => {
            const errors: unknown[] = [];
            for (const cleanup of [...disposers].reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
            disposers.length = 0;
            if (errors.length) throw new AggregateError(errors, 'Extension cleanup failed');
          });
        }
        return disposal;
      }
      for (const entry of ordered) {
        let open = true;
        const guard = () => { if (!open || disposed) throw new Error('Extension registration is only available during setup'); };
        const api: ExtensionAPI = Object.freeze({
          registerAction(...args: Parameters<TreeRegistry['registerAction']>) { guard(); registry.registerAction(...args); },
          registerCondition(...args: Parameters<TreeRegistry['registerCondition']>) { guard(); registry.registerCondition(...args); },
          registerNode(...args: Parameters<TreeRegistry['registerNode']>) { guard(); registry.registerNode(...args); },
          registerValue<T>(name: string, codec: ValueCodec<T>) { guard(); registry.registerValue(name, codec); },
          createNode(...args: Parameters<TreeRegistry['createNode']>) { guard(); return registry.createNode(...args); },
          registerService(name: string, value: unknown) {
            guard(); if (!nonempty(name) || Object.hasOwn(services, name)) throw new Error(`Invalid or duplicate service: ${name}`);
            services[name] = value;
          },
          getService(name: string) { if (disposed) throw new Error('Extension session is disposed'); return services[name]; },
          onDispose(cleanup: ExtensionDisposer) { guard(); if (typeof cleanup !== 'function') throw new TypeError('Expected a disposer'); disposers.push(cleanup); }
        });
        try {
          const result = await entry.manifest.setup(api, entry.declaration.options);
          if (result !== undefined) {
            if (!result || typeof result.dispose !== 'function') throw new TypeError('Setup must return undefined or { dispose }');
            const cleanup = result.dispose;
            disposers.push(() => cleanup.call(result));
          }
        } catch (error) {
          open = false;
          let cause: unknown = error;
          try { await dispose(); } catch (cleanup) { cause = new AggregateError([error, cleanup], 'Setup and rollback failed'); }
          throw new ExtensionError(entry.declaration.id, entry.location, 'setup failed', cause);
        } finally { open = false; }
      }
      Object.freeze(services);
      return Object.freeze({ registry, services, dispose,
        snapshot: () => Object.freeze(ordered.map(entry => Object.freeze({ id: entry.manifest.id,
          declarationId: entry.declaration.id, version: entry.manifest.version, location: entry.location,
          dependencies: entry.manifest.dependencies!, status: disposed ? 'disposed' as const : 'ready' as const })))
      });
    }
  });
}
