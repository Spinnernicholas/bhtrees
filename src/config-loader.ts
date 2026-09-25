import { DocumentError } from './document-error.js';
import { decodeConfig, parseDocumentText, resolveConfiguration, validateConfiguration, copyConfigValue, validateConfigURI, resolveConfigURI } from './config.js';
import type { Configuration, ConfigLayer, ResolvedConfiguration } from './config.js';
import { fromTreeDocument, validateTreeDocument } from './serialization.js';
import type { SerializationOptions, TreeDocument } from './serialization.js';
import { createRunner } from './runner.js';
import { createBlackboard } from './blackboard.js';
import type { NodeDefinition, Runner, RunnerOptions } from './types.js';
import type { ExtensionLoader, ExtensionSession, ExtensionSnapshot } from './extensions.js';
import type { TreeRegistry } from './serialization.js';

export interface ConfigFileContent { text: string; codec: 'json' | 'yaml' }
export interface ConfiguredTreeOptions extends SerializationOptions {
  /** Absolute URI of the declaring tree, used to resolve configFile. */
  baseURI?: string;
  readConfig?: (uri: string) => ConfigFileContent | Promise<ConfigFileContent>;
  config?: Configuration;
  overrides?: Configuration;
  /** Declaring URI for explicit config/overrides; defaults to baseURI. */
  configBaseURI?: string;
  overridesBaseURI?: string;
  extensionLoader?: ExtensionLoader;
}
export type ConfiguredRunnerOptions = Omit<RunnerOptions, 'maxStepsPerTick' | 'blackboard'>;
export interface ConfiguredTree extends ResolvedConfiguration {
  readonly tree: NodeDefinition;
  readonly registry?: TreeRegistry;
  extensionSnapshot(): readonly ExtensionSnapshot[];
  dispose(): Promise<void>;
  /** Each call creates a separate blackboard when enabled. */
  createRunner(options?: ConfiguredRunnerOptions): Runner;
}
function fail(path: string, message: string): never { throw new DocumentError(path, message); }

/** Resolve one config reference through an injected host reader, then build the tree. */
async function prepareConfiguredTree(text: string, options: ConfiguredTreeOptions) {
  const { registry, codec, baseURI, readConfig } = options;
  const configBaseURI = options.configBaseURI ?? baseURI, overridesBaseURI = options.overridesBaseURI ?? baseURI;
  const document = parseDocumentText(text, { codec }) as TreeDocument;
  validateTreeDocument(document, { registry }, !!options.extensionLoader);
  // Snapshot caller-owned layers before awaiting host I/O.
  const explicit = options.config === undefined ? undefined : validateConfiguration(options.config, '$options.config');
  const overrides = options.overrides === undefined ? undefined : validateConfiguration(options.overrides, '$options.overrides');
  if (baseURI !== undefined) validateConfigURI(baseURI, '$options.baseURI');
  if (configBaseURI !== undefined) validateConfigURI(configBaseURI, '$options.configBaseURI');
  if (overridesBaseURI !== undefined) validateConfigURI(overridesBaseURI, '$options.overridesBaseURI');
  const layers: ConfigLayer[] = [];
  if (document.configFile !== undefined) {
    const uri = resolveConfigURI(document.configFile, baseURI, '$.configFile');
    if (typeof readConfig !== 'function') fail('$.configFile', 'A readConfig host callback is required');
    let referenced: Configuration;
    try {
      const file = await readConfig!(uri!);
      if (!file || typeof file.text !== 'string' || !['json', 'yaml'].includes(file.codec)) throw new TypeError('readConfig must return { text, codec: json | yaml }');
      referenced = decodeConfig(file.text, { codec: file.codec });
    } catch (error) {
      return fail('$.configFile', `Could not load ${uri!}: ${error instanceof Error ? error.message : String(error)}`);
    }
    layers.push({ config: referenced, source: { layer: 'file', uri: uri! } });
  }
  if (document.config !== undefined) layers.push({ config: document.config, source: { layer: 'embedded', ...(baseURI ? { uri: baseURI } : {}) } });
  if (explicit !== undefined) layers.push({ config: explicit, source: { layer: 'explicit', ...(configBaseURI ? { uri: configBaseURI } : {}) } });
  if (overrides !== undefined) layers.push({ config: overrides, source: { layer: 'overrides', ...(overridesBaseURI ? { uri: overridesBaseURI } : {}) } });
  const resolved = resolveConfiguration(layers);
  return { document, registry, resolved };
}

/** Resolve configuration for inspection without constructing nodes or loading extensions. */
export async function resolveTreeConfiguration(text: string, options: ConfiguredTreeOptions = {}): Promise<ResolvedConfiguration> {
  return (await prepareConfiguredTree(text, options)).resolved;
}

export async function loadConfiguredTree(text: string, options: ConfiguredTreeOptions = {}): Promise<ConfiguredTree> {
  const extensionLoader = options.extensionLoader;
  const { document, registry, resolved } = await prepareConfiguredTree(text, options);
  const pending = resolved.config.extensions.findIndex(extension => extension.enabled);
  if (pending >= 0 && !extensionLoader) fail(`$.config.extensions[${pending}]`, 'Enabled extensions require an extension loader; use resolveTreeConfiguration to inspect declarations');
  let session: ExtensionSession | undefined;
  let tree: NodeDefinition;
  try {
    if (extensionLoader) session = await extensionLoader.load(resolved.config.extensions, { registry });
    tree = fromTreeDocument(document, { registry: session?.registry ?? registry });
  } catch (error) {
    try { await session?.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Tree loading and extension cleanup failed'); }
    throw error;
  }
  const runners = new Set<Runner>();
  let disposed = false, disposal: Promise<void> | undefined;
  return Object.freeze({ tree, ...resolved,
    registry: session?.registry ?? registry,
    extensionSnapshot: () => session?.snapshot() ?? Object.freeze([]),
    dispose() {
      if (!disposal) {
        disposed = true;
        disposal = Promise.resolve().then(async () => {
          const errors: unknown[] = [];
          for (const runner of runners) {
            try {
              const before = runner.snapshot();
              runner.cancel('configured tree disposed');
              const after = runner.snapshot();
              if (after.error !== undefined && after.error !== before.error) errors.push(after.error);
            } catch (error) { errors.push(error); }
          }
          runners.clear();
          try { await session?.dispose(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, 'Configured tree disposal failed');
        });
      }
      return disposal;
    },
    createRunner(options: ConfiguredRunnerOptions = {}) {
      if (disposed) fail('$runner', 'Configured tree is disposed');
      if ('blackboard' in options || 'maxStepsPerTick' in options) fail('$runner', 'Use configuration overrides for blackboard and step budget');
      const services = Object.assign(Object.create(null), session?.services);
      for (const [name, value] of Object.entries(options.services ?? {})) {
        if (Object.hasOwn(services, name)) fail(`$runner.services[${JSON.stringify(name)}]`, 'Service conflicts with an extension service');
        services[name] = value;
      }
      const initial = copyConfigValue(resolved.config.blackboard.initial) as Record<string, unknown>;
      const runner = createRunner(tree, { ...options, services, maxStepsPerTick: resolved.config.runtime.maxStepsPerTick,
        ...(resolved.config.blackboard.enabled ? { blackboard: createBlackboard(initial) } : {}) });
      runners.add(runner);
      const release = (state: ReturnType<Runner['snapshot']>) => {
        if (state.status !== 'idle' && state.status !== 'RUNNING') runners.delete(runner);
        return state;
      };
      return Object.freeze({ ...runner,
        tick: () => release(runner.tick()), step: () => release(runner.step()),
        cancel: (reason?: string) => release(runner.cancel(reason)) });
    }
  });
}
