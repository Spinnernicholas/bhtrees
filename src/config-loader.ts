import { DocumentError } from './document-error.js';
import { decodeConfig, parseDocumentText, resolveConfiguration, validateConfiguration, copyConfigValue, validateConfigURI, resolveConfigURI } from './config.js';
import type { Configuration, ConfigLayer, ResolvedConfiguration } from './config.js';
import { fromTreeDocument, validateTreeDocument } from './serialization.js';
import type { SerializationOptions, TreeDocument } from './serialization.js';
import { createRunner } from './runner.js';
import { createBlackboard } from './blackboard.js';
import type { NodeDefinition, Runner, RunnerOptions } from './types.js';

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
}
export type ConfiguredRunnerOptions = Omit<RunnerOptions, 'maxStepsPerTick' | 'blackboard'>;
export interface ConfiguredTree extends ResolvedConfiguration {
  readonly tree: NodeDefinition;
  /** Each call creates a separate blackboard when enabled. */
  createRunner(options?: ConfiguredRunnerOptions): Runner;
}
function fail(path: string, message: string): never { throw new DocumentError(path, message); }

/** Resolve one config reference through an injected host reader, then build the tree. */
async function prepareConfiguredTree(text: string, options: ConfiguredTreeOptions) {
  const { registry, codec, baseURI, readConfig } = options;
  const configBaseURI = options.configBaseURI ?? baseURI, overridesBaseURI = options.overridesBaseURI ?? baseURI;
  const document = parseDocumentText(text, { codec }) as TreeDocument;
  validateTreeDocument(document, { registry });
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
  const { document, registry, resolved } = await prepareConfiguredTree(text, options);
  const pending = resolved.config.extensions.findIndex(extension => extension.enabled);
  if (pending >= 0) fail(`$.config.extensions[${pending}]`, 'Enabled extensions require an extension loader; use resolveTreeConfiguration to inspect declarations');
  const tree = fromTreeDocument(document, { registry });
  return Object.freeze({ tree, ...resolved,
    createRunner(options: ConfiguredRunnerOptions = {}) {
      if ('blackboard' in options || 'maxStepsPerTick' in options) fail('$runner', 'Use configuration overrides for blackboard and step budget');
      const initial = copyConfigValue(resolved.config.blackboard.initial) as Record<string, unknown>;
      return createRunner(tree, { ...options, maxStepsPerTick: resolved.config.runtime.maxStepsPerTick,
        ...(resolved.config.blackboard.enabled ? { blackboard: createBlackboard(initial) } : {}) });
    }
  });
}
