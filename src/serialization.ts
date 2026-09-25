import { DocumentError } from './document-error.js';
import { parseYaml, stringifyYaml } from './yaml.js';
import { validateConfiguration } from './config.js';
import type { Configuration } from './config.js';
export { DocumentError } from './document-error.js';
import { attachValueRegistry, copyValueRegistry, registerValueType, toPortableValue, fromPortableValue } from './values.js';
import type { ValueCodec, PortableValue } from './values.js';
import * as nodes from './nodes.js';
import { normalizeBinding } from './bindings.js';
import type { ActionOptions, ActionDefinition, ConditionDefinition, NodeDefinition, PathBinding, Reactive, Value } from './types.js';

export type ActionImplementation = ActionOptions extends infer O ? O extends ActionOptions ? Omit<O, 'id' | 'reactive'> : never : never;
export interface NodeFactoryOptions {
  id: string;
  reactive: Reactive;
  data: unknown;
  children: readonly NodeDefinition[];
}
export interface NodeFactory {
  version: number;
  create(options: NodeFactoryOptions): NodeDefinition;
  /** Each entry upgrades that version's decoded data to the next version. */
  migrations?: Readonly<Record<number, (data: unknown) => unknown>>;
}
export interface CreateNodeOptions {
  id: string;
  reactive?: Reactive;
  data: unknown;
  children?: readonly NodeDefinition[];
}
export interface TreeRegistry {
  registerNode(name: string, factory: NodeFactory): void;
  createNode(name: string, options: CreateNodeOptions): NodeDefinition;
  registerValue<T>(name: string, codec: ValueCodec<T>): void;
  registerAction(name: string, implementation: ActionImplementation, version?: number): void;
  registerCondition(name: string, test: ConditionDefinition['test'], version?: number): void;
}
interface Entry { name: string; version: number; definition: ActionDefinition | ConditionDefinition }
const registries = new WeakMap<TreeRegistry, Map<string, Entry>>();
const factories = new WeakMap<TreeRegistry, Map<string, NodeFactory>>();
const customNodes = new WeakMap<NodeDefinition, { registry: TreeRegistry; name: string; data: PortableValue; children: readonly NodeDefinition[] }>();

export function createRegistry(): TreeRegistry {
  const entries = new Map<string, Entry>();
  const nodeFactories = new Map<string, NodeFactory>();
  function register(name: string, version: number, definition: Entry['definition']) {
    if (typeof name !== 'string' || !name) throw new TypeError('Registry names must be nonempty strings');
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError('Registry versions must be positive safe integers');
    if (entries.has(name) || nodeFactories.has(name)) throw new TypeError(`Duplicate implementation name: ${name}`);
    entries.set(name, { name, version, definition });
  }
  const registry: TreeRegistry = Object.freeze({
    registerNode(name: string, factory: NodeFactory) {
      if (typeof name !== 'string' || !name) throw new TypeError('Registry names must be nonempty strings');
      if (!factory || !Number.isSafeInteger(factory.version) || factory.version < 1 || typeof factory.create !== 'function') throw new TypeError('Node factories require a positive safe integer version and create function');
      if (entries.has(name) || nodeFactories.has(name)) throw new TypeError(`Duplicate implementation name: ${name}`);
      const migrations = { ...factory.migrations };
      for (const [key, migrate] of Object.entries(migrations)) {
        const version = Number(key);
        if (!Number.isSafeInteger(version) || version < 1 || version >= factory.version || String(version) !== key || typeof migrate !== 'function') throw new TypeError('Invalid node migration');
      }
      nodeFactories.set(name, Object.freeze({ version: factory.version, create: factory.create, migrations: Object.freeze(migrations) }));
    },
    createNode(name: string, options: CreateNodeOptions) {
      const factory = nodeFactories.get(name);
      if (!factory) fail('$node.implementation', `Unknown node implementation: ${name}`);
      return constructNode(registry, name, factory, options, '$node');
    },
    registerValue<T>(name: string, codec: ValueCodec<T>) { registerValueType(registry, name, codec); },
    registerAction(name: string, implementation: ActionImplementation, version = 1) {
      register(name, version, nodes.action({ ...implementation, id: name }));
    },
    registerCondition(name: string, test: ConditionDefinition['test'], version = 1) {
      register(name, version, nodes.condition({ id: name, test }));
    }
  });
  registries.set(registry, entries);
  factories.set(registry, nodeFactories);
  attachValueRegistry(registry);
  return registry;
}

/** Internal per-load copy: extension registration never mutates the host registry. */
export function forkRegistry(source?: TreeRegistry): TreeRegistry {
  const target = createRegistry();
  if (source !== undefined) {
    const entries = registryEntries(source);
    for (const [name, entry] of entries) registries.get(target)!.set(name, entry);
    for (const [name, entry] of factories.get(source)!) factories.get(target)!.set(name, entry);
    copyValueRegistry(source, target);
  }
  return target;
}

export interface TreeStepDocument { node: string; input?: PathBinding; save?: string }
export interface TreeNodeDocument {
  id: string;
  type: NodeDefinition['type'] | 'custom';
  data?: PortableValue;
  children?: string[];
  reactive?: Reactive;
  implementation?: string;
  implementationVersion?: number;
  steps?: TreeStepDocument[];
  child?: string;
  input?: PathBinding;
  output?: PathBinding;
  attempts?: number | 'unbounded';
  times?: number | 'unbounded';
  ms?: number;
  successThreshold?: number;
  failureThreshold?: number;
}
export interface TreeDocument {
  format: 'bhtrees';
  version: 1;
  kind: 'tree';
  root: string;
  nodes: TreeNodeDocument[];
  config?: Configuration;
  configFile?: string;
}
export interface SerializationOptions { registry?: TreeRegistry; codec?: 'json' | 'yaml' }
export interface TreeSerializationOptions extends SerializationOptions { config?: Configuration; configFile?: string }
const treeConfiguration = new WeakMap<NodeDefinition, { config?: Configuration; configFile?: string }>();
const MAX_DEPTH = 128, MAX_NODES = 10000, MAX_TEXT = 1000000;
const builtinTypes = ['sequence', 'selector', 'parallel', 'inverter', 'forceSuccess', 'forceFailure', 'retry', 'repeat', 'delay', 'timeout', 'cooldown', 'subtree'];
function fail(path: string, message: string): never { throw new DocumentError(path, message); }
function atPath<T>(path: string, callback: () => T): T {
  try { return callback(); }
  catch (error) {
    if (error instanceof DocumentError) fail(path + error.path.slice(1), error.message);
    fail(path, error instanceof Error ? error.message : String(error));
  }
}
function childrenOf(node: NodeDefinition): readonly NodeDefinition[] {
  return 'steps' in node ? node.steps.map(step => step.node) : 'child' in node ? [node.child] : [];
}
function constructNode(registry: TreeRegistry, name: string, factory: NodeFactory, options: CreateNodeOptions, path: string): NodeDefinition {
  const id = string(options.id, `${path}.id`), reactive = options.reactive === undefined ? 'inherited' : options.reactive;
  if (![true, false, 'inherited'].includes(reactive)) fail(`${path}.reactive`, 'Invalid reactive setting');
  if (options.children !== undefined && !Array.isArray(options.children)) fail(`${path}.children`, 'Expected an array');
  const children = Object.freeze([...(options.children ?? [])]);
  const data = atPath(`${path}.data`, () => toPortableValue(options.data, { registry }));
  const decoded = atPath(`${path}.data`, () => fromPortableValue(data, { registry }));
  const result = atPath(path, () => factory.create(Object.freeze({ id, reactive, data: decoded, children })));
  if (!result || result.id !== id || result.reactive !== reactive) fail(path, 'Node factory must preserve id and reactive');
  if (!['action', 'condition', ...builtinTypes].includes(result.type)) fail(path, 'Node factory must return a built-in node definition');
  // Normalize through the public constructor so invalid callback/options cannot enter the engine.
  const node = atPath(path, () => (nodes[result.type as keyof typeof nodes] as (options: Value) => NodeDefinition)(result));
  const actual = childrenOf(node);
  if (actual.length !== children.length || actual.some((child, index) => child !== children[index])) fail(`${path}.children`, 'Node factory must preserve declared children in order');
  customNodes.set(node, { registry, name, data, children });
  return node;
}
function registryEntries(registry?: TreeRegistry) {
  if (!registry) return new Map<string, Entry>();
  const entries = registries.get(registry);
  if (!entries) fail('$registry', 'Expected a registry created by createRegistry');
  return entries;
}
function pathBinding(value: Value, path: string): PathBinding {
  if (typeof value === 'function') fail(path, 'Function bindings are not portable; use a declarative path');
  try { return normalizeBinding(value, 'path binding') as PathBinding; }
  catch (error) { fail(path, (error as Error).message); }
}
function sameAction(a: ActionDefinition, b: ActionDefinition) {
  return a.enter === b.enter && a.tick === b.tick && a.cancel === b.cancel &&
    Object.keys(a.resume).length === Object.keys(b.resume).length &&
    Object.keys(a.resume).every(name => Object.hasOwn(b.resume, name) && a.resume[name] === b.resume[name]);
}

/** Encode definitions only. No services, runner state, or executable source is captured. */
export function toTreeDocument(root: NodeDefinition, options: TreeSerializationOptions = {}): TreeDocument {
  const { registry } = options;
  const entries = registryEntries(registry), seen = new Map<string, NodeDefinition>(), active = new Set<NodeDefinition>();
  const table: TreeNodeDocument[] = [];
  function visit(node: NodeDefinition, path: string, depth: number): string {
    if (depth > MAX_DEPTH) fail(path, 'Tree depth exceeds 128');
    if (!node || typeof node.id !== 'string' || !node.id) fail(path, 'Expected a node with a nonempty ID');
    if (active.has(node)) fail(path, 'Cyclic definition');
    if (seen.has(node.id)) {
      if (seen.get(node.id) !== node) fail(path, `Duplicate node ID: ${node.id}`);
      return node.id;
    }
    if (table.length >= MAX_NODES) fail(path, 'Too many nodes');
    seen.set(node.id, node); active.add(node);
    const record: TreeNodeDocument = { id: node.id, type: node.type, reactive: node.reactive };
    const location = `$.nodes[${table.length}]`;
    table.push(record);
    const custom = customNodes.get(node);
    if (custom) {
      if (custom.registry !== registry) fail(`${location}.implementation`, 'Custom node belongs to a different registry');
      record.type = 'custom';
      record.implementation = custom.name;
      record.implementationVersion = factories.get(registry!)!.get(custom.name)!.version;
      // Copy the envelope without invoking application codecs a second time.
      record.data = JSON.parse(JSON.stringify(custom.data)) as PortableValue;
      record.children = custom.children.map((child, index) => visit(child, `${location}.children[${index}]`, depth + 1));
    } else if (node.type === 'action' || node.type === 'condition') {
      const entry = [...entries.values()].find(entry => node.type === 'action'
        ? entry.definition.type === 'action' && sameAction(node, entry.definition)
        : entry.definition.type === 'condition' && node.test === entry.definition.test);
      if (!entry) fail(`${location}.implementation`, `Unregistered ${node.type} implementation (${node.id})`);
      record.implementation = entry.name; record.implementationVersion = entry.version;
    } else {
      if (!builtinTypes.includes(node.type)) fail(`${location}.type`, 'Unsupported node type');
      if ('steps' in node) record.steps = node.steps.map((step, index) => ({
        node: visit(step.node, `${location}.steps[${index}].node`, depth + 1),
        ...(step.input === undefined ? {} : { input: pathBinding(step.input, `${location}.steps[${index}].input`) }),
        ...(step.save === undefined ? {} : { save: step.save })
      }));
      if ('child' in node) record.child = visit(node.child, `${location}.child`, depth + 1);
      if ('output' in node) record.output = pathBinding(node.output, `${location}.output`);
      if (node.type === 'subtree' && node.input !== undefined) record.input = pathBinding(node.input, `${location}.input`);
      if (node.type === 'retry') record.attempts = node.attempts === Infinity ? 'unbounded' : node.attempts;
      if (node.type === 'repeat') record.times = node.times === Infinity ? 'unbounded' : node.times;
      if ('ms' in node) record.ms = node.ms;
      if (node.type === 'parallel') { record.successThreshold = node.successThreshold; record.failureThreshold = node.failureThreshold; }
    }
    active.delete(node);
    return node.id;
  }
  const document: TreeDocument = { format: 'bhtrees', version: 1, kind: 'tree', root: visit(root, '$root', 0), nodes: table };
  const stored = treeConfiguration.get(root);
  const config = options.config === undefined ? stored?.config : options.config;
  const configFile = options.configFile === undefined ? stored?.configFile : options.configFile;
  if (config !== undefined) document.config = validateConfiguration(config);
  if (configFile !== undefined) document.configFile = configFile;
  // Reuse structural and graph validation, including counts and supported fields.
  readTreeDocument(document, { registry }, seen);
  return document;
}

function record(value: Value, path: string): Record<string, Value> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'Expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) fail(path, 'Only string-keyed data properties are supported');
  }
  return value;
}
function fields(value: Record<string, Value>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'Unknown field');
}
function string(value: Value, path: string): string {
  if (typeof value !== 'string' || !value) fail(path, 'Expected a nonempty string');
  return value;
}

export function fromTreeDocument(value: unknown, { registry }: SerializationOptions = {}): NodeDefinition {
  // Reject malformed structure/references before invoking any application factories.
  readTreeDocument(value, { registry }, undefined, true);
  const tree = readTreeDocument(value, { registry });
  const document = value as TreeDocument;
  if (document.config !== undefined || document.configFile !== undefined) treeConfiguration.set(tree, {
    ...(document.config === undefined ? {} : { config: validateConfiguration(document.config) }),
    ...(document.configFile === undefined ? {} : { configFile: document.configFile })
  });
  return tree;
}

export function validateTreeDocument(value: unknown, options: SerializationOptions = {}, deferImplementations = false): void {
  readTreeDocument(value, options, undefined, true, deferImplementations);
}

function readTreeDocument(value: unknown, { registry }: SerializationOptions, exported?: Map<string, NodeDefinition>, validateOnly = false, deferImplementations = false): NodeDefinition {
  const entries = registryEntries(registry);
  const document = record(value, '$');
  fields(document, ['format', 'version', 'kind', 'root', 'nodes', 'config', 'configFile'], '$');
  if (document.format !== 'bhtrees') fail('$.format', 'Expected bhtrees');
  if (document.version !== 1) fail('$.version', 'Unsupported schema version; expected 1');
  if (document.kind !== 'tree') fail('$.kind', 'Expected tree');
  if (Object.hasOwn(document, 'config')) validateConfiguration(document.config);
  if (Object.hasOwn(document, 'configFile')) string(document.configFile, '$.configFile');
  const root = string(document.root, '$.root');
  if (!Array.isArray(document.nodes) || document.nodes.length === 0 || document.nodes.length > MAX_NODES) fail('$.nodes', 'Expected 1 to 10000 nodes');
  const table = new Map<string, { data: Record<string, Value>; path: string }>();
  for (const [index, item] of document.nodes.entries()) {
    const path = `$.nodes[${index}]`, data = record(item, path);
    const id = string(data.id, `${path}.id`);
    if (table.has(id)) fail(`${path}.id`, `Duplicate node ID: ${id}`);
    table.set(id, { data, path });
  }
  const built = new Map<string, NodeDefinition>(), active = new Set<string>();
  const heights = new Map<string, number>();
  function build(id: string, referencePath: string, depth: number): NodeDefinition {
    if (depth > MAX_DEPTH) fail(referencePath, 'Tree depth exceeds 128');
    if (active.has(id)) fail(referencePath, `Cyclic reference: ${id}`);
    const cached = built.get(id);
    if (cached) {
      if (depth + heights.get(id)! > MAX_DEPTH) fail(referencePath, 'Tree depth exceeds 128');
      return cached;
    }
    const item = table.get(id); if (!item) fail(referencePath, `Unknown node reference: ${id}`);
    const { data, path } = item;
    active.add(id);
    const type = data.type;
    const common = { id, reactive: data.reactive ?? 'inherited' };
    if (data.reactive !== undefined && ![true, false, 'inherited'].includes(data.reactive)) fail(`${path}.reactive`, 'Invalid reactive setting');
    const base = ['id', 'type', 'reactive'];
    let node: NodeDefinition;
    if (type === 'custom') {
      fields(data, [...base, 'implementation', 'implementationVersion', 'data', 'children'], path);
      const name = string(data.implementation, `${path}.implementation`);
      const factory = registry && factories.get(registry)!.get(name);
      if (!factory && !deferImplementations) fail(`${path}.implementation`, `Unknown node implementation: ${name}`);
      const version = data.implementationVersion;
      if (!Number.isSafeInteger(version) || version < 1 || (!deferImplementations && version > factory!.version)) fail(`${path}.implementationVersion`, 'Unsupported node implementation version');
      if (!deferImplementations) {
        if (factory!.version - version > MAX_DEPTH) fail(`${path}.implementationVersion`, 'Too many migration steps');
        for (let v = version; v < factory!.version; v++) if (!factory!.migrations?.[v]) fail(`${path}.implementationVersion`, `Missing migration from version ${v}`);
      }
      if (!Array.isArray(data.children)) fail(`${path}.children`, 'Expected an array');
      const children = data.children.map((child: Value, index: number) => build(string(child, `${path}.children[${index}]`), `${path}.children[${index}]`, depth + 1));
      if (exported) node = exported.get(id)!;
      else if (validateOnly) node = nodes.sequence({ ...common, steps: children.map((node: NodeDefinition) => ({ node })) });
      else {
        let payload = atPath(`${path}.data`, () => fromPortableValue(data.data, { registry }));
        for (let v = version; v < factory!.version; v++) payload = atPath(`${path}.data`, () => factory!.migrations![v](payload));
        node = constructNode(registry!, name, factory!, { ...common, data: payload, children }, path);
      }
    } else if (type === 'action' || type === 'condition') {
      fields(data, [...base, 'implementation', 'implementationVersion'], path);
      const name = string(data.implementation, `${path}.implementation`), entry = entries.get(name);
      if (deferImplementations) {
        if (!Number.isSafeInteger(data.implementationVersion) || data.implementationVersion < 1) fail(`${path}.implementationVersion`, 'Expected a positive implementation version');
        node = type === 'action' ? nodes.action({ ...common, tick: () => nodes.SUCCESS }) : nodes.condition({ ...common, test: () => true });
      } else {
        if (!entry || entry.definition.type !== type) fail(`${path}.implementation`, `Unknown ${type} implementation: ${name}`);
        if (data.implementationVersion !== entry.version) fail(`${path}.implementationVersion`, `Unsupported implementation version; expected ${entry.version}`);
        node = entry.definition.type === 'action' ? nodes.action({ ...entry.definition, ...common })
          : nodes.condition({ ...common, test: entry.definition.test });
      }
    } else {
      if (!builtinTypes.includes(type)) fail(`${path}.type`, 'Unsupported node type');
      const composite = ['sequence', 'selector', 'parallel'].includes(type);
      const extra = composite ? ['steps', 'output'] : ['child'];
      if (type === 'parallel') extra.push('successThreshold', 'failureThreshold');
      if (type === 'subtree') extra.push('input', 'output');
      if (type === 'retry') extra.push('attempts');
      if (type === 'repeat') extra.push('times');
      if (['delay', 'timeout', 'cooldown'].includes(type)) extra.push('ms');
      fields(data, [...base, ...extra], path);
      const output = data.output === undefined ? undefined : pathBinding(data.output, `${path}.output`);
      const input = data.input === undefined ? undefined : pathBinding(data.input, `${path}.input`);
      const options: Value = { ...common, ...(output ? { output } : {}), ...(input ? { input } : {}) };
      if (composite) {
        if (!Array.isArray(data.steps)) fail(`${path}.steps`, 'Expected an array');
        options.steps = data.steps.map((value: Value, index: number) => {
          const stepPath = `${path}.steps[${index}]`, step = record(value, stepPath);
          fields(step, type === 'parallel' ? ['node', 'input'] : ['node', 'input', 'save'], stepPath);
          if (step.save !== undefined && typeof step.save !== 'string') fail(`${stepPath}.save`, 'Expected a string');
          return { node: build(string(step.node, `${stepPath}.node`), `${stepPath}.node`, depth + 1),
            ...(step.input === undefined ? {} : { input: pathBinding(step.input, `${stepPath}.input`) }),
            ...(step.save === undefined ? {} : { save: step.save }) };
        });
      } else options.child = build(string(data.child, `${path}.child`), `${path}.child`, depth + 1);
      for (const key of ['attempts', 'times', 'ms', 'successThreshold', 'failureThreshold']) {
        if (!extra.includes(key)) continue;
        const value = data[key];
        const minimum = key === 'times' || key === 'ms' ? 0 : 1;
        if ((key === 'attempts' || key === 'times') && value === 'unbounded') options[key] = Infinity;
        else {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || (key !== 'ms' && !Number.isSafeInteger(value))) fail(`${path}.${key}`, `Expected a valid ${key}`);
          options[key] = value;
        }
      }
      try { node = (nodes[type as keyof typeof nodes] as (options: Value) => NodeDefinition)(options); }
      catch (error) { fail(path, (error as Error).message); }
    }
    const children = 'steps' in node ? node.steps.map(step => step.node) : 'child' in node ? [node.child] : [];
    let height = 0;
    for (const child of children) height = Math.max(height, 1 + heights.get(child.id)!);
    if (depth + height > MAX_DEPTH) fail(referencePath, 'Tree depth exceeds 128');
    heights.set(id, height);
    active.delete(id); built.set(id, node); return node;
  }
  const result = build(root, '$.root', 0);
  if (built.size !== table.size) fail('$.nodes', 'Unreachable node definitions are not allowed');
  return result;
}

export function encodeTree(root: NodeDefinition, options: TreeSerializationOptions = {}): string {
  if (options.codec === 'yaml') return stringifyYaml(toTreeDocument(root, options));
  if (options.codec !== undefined && options.codec !== 'json') fail('$codec', 'Unsupported codec');
  const text = JSON.stringify(toTreeDocument(root, options), null, 2);
  if (text.length > MAX_TEXT) fail('$', 'Document exceeds 1000000 characters');
  return text;
}
export function decodeTree(text: string, options: SerializationOptions = {}): NodeDefinition {
  if (options.codec === 'yaml') return fromTreeDocument(parseYaml(text), options);
  if (options.codec !== undefined && options.codec !== 'json') fail('$codec', 'Unsupported codec');
  if (typeof text !== 'string' || text.length > MAX_TEXT) fail('$', 'Expected JSON text of at most 1000000 characters');
  let document: unknown;
  try { document = JSON.parse(text); } catch (error) { fail('$', `Invalid JSON: ${(error as Error).message}`); }
  return fromTreeDocument(document, options);
}
