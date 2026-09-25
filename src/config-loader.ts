import { DocumentError } from './document-error.js';
import { decodeConfig, parseDocumentText, resolveConfiguration, validateConfiguration, copyConfigValue } from './config.js';
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
}
export type ConfiguredRunnerOptions = Omit<RunnerOptions, 'maxStepsPerTick' | 'blackboard'>;
export interface ConfiguredTree extends ResolvedConfiguration {
  readonly tree: NodeDefinition;
  /** Each call creates a separate blackboard when enabled. */
  createRunner(options?: ConfiguredRunnerOptions): Runner;
}
function fail(path: string, message: string): never { throw new DocumentError(path, message); }

/** Resolve one config reference through an injected host reader, then build the tree. */
export async function loadConfiguredTree(text: string, options: ConfiguredTreeOptions = {}): Promise<ConfiguredTree> {
  const { registry, codec, baseURI, readConfig } = options;
  const document = parseDocumentText(text, { codec }) as TreeDocument;
  validateTreeDocument(document, { registry });
  // Snapshot caller-owned layers before awaiting host I/O.
  const explicit = options.config === undefined ? undefined : validateConfiguration(options.config, '$options.config');
  const overrides = options.overrides === undefined ? undefined : validateConfiguration(options.overrides, '$options.overrides');
  if (baseURI !== undefined) {
    try {
      if (typeof baseURI !== 'string' || /^[a-zA-Z]:[\\/]/.test(baseURI) || baseURI.includes('\\')) throw Error('Use a URI');
      new URL(baseURI);
    } catch { fail('$options.baseURI', 'Expected an absolute base URI; use file URLs for filesystem paths'); }
  }
  const layers: ConfigLayer[] = [];
  if (document.configFile !== undefined) {
    let uri: string;
    try {
      if (/^[a-zA-Z]:[\\/]/.test(document.configFile) || document.configFile.includes('\\')) throw Error('Use a URI');
      uri = new URL(document.configFile, baseURI).href;
    } catch { return fail('$.configFile', 'Relative configFile requires an absolute baseURI; use file URLs for filesystem paths'); }
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
  if (explicit !== undefined) layers.push({ config: explicit, source: { layer: 'explicit' } });
  if (overrides !== undefined) layers.push({ config: overrides, source: { layer: 'overrides' } });
  const resolved = resolveConfiguration(layers);
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
