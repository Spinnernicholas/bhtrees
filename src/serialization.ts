import * as nodes from './nodes.js';
import { normalizeBinding } from './bindings.js';
import type { ActionOptions, ActionDefinition, ConditionDefinition, NodeDefinition, PathBinding, Reactive, Value } from './types.js';

export type ActionImplementation = ActionOptions extends infer O ? O extends ActionOptions ? Omit<O, 'id' | 'reactive'> : never : never;
export interface TreeRegistry {
  registerAction(name: string, implementation: ActionImplementation, version?: number): void;
  registerCondition(name: string, test: ConditionDefinition['test'], version?: number): void;
}
interface Entry { name: string; version: number; definition: ActionDefinition | ConditionDefinition }
const registries = new WeakMap<TreeRegistry, Map<string, Entry>>();

export function createRegistry(): TreeRegistry {
  const entries = new Map<string, Entry>();
  function register(name: string, version: number, definition: Entry['definition']) {
    if (typeof name !== 'string' || !name) throw new TypeError('Registry names must be nonempty strings');
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError('Registry versions must be positive safe integers');
    if (entries.has(name)) throw new TypeError(`Duplicate implementation name: ${name}`);
    entries.set(name, { name, version, definition });
  }
  const registry: TreeRegistry = Object.freeze({
    registerAction(name: string, implementation: ActionImplementation, version = 1) {
      register(name, version, nodes.action({ ...implementation, id: name }));
    },
    registerCondition(name: string, test: ConditionDefinition['test'], version = 1) {
      register(name, version, nodes.condition({ id: name, test }));
    }
  });
  registries.set(registry, entries);
  return registry;
}

export interface TreeStepDocument { node: string; input?: PathBinding; save?: string }
export interface TreeNodeDocument {
  id: string;
  type: NodeDefinition['type'];
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
}
export class DocumentError extends TypeError {
  constructor(public readonly path: string, message: string) { super(`${path}: ${message}`); this.name = 'DocumentError'; }
}
export interface SerializationOptions { registry?: TreeRegistry }
const MAX_DEPTH = 128, MAX_NODES = 10000, MAX_TEXT = 1000000;
const builtinTypes = ['sequence', 'selector', 'parallel', 'inverter', 'forceSuccess', 'forceFailure', 'retry', 'repeat', 'delay', 'timeout', 'cooldown', 'subtree'];
function fail(path: string, message: string): never { throw new DocumentError(path, message); }
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
export function toTreeDocument(root: NodeDefinition, { registry }: SerializationOptions = {}): TreeDocument {
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
    if (node.type === 'action' || node.type === 'condition') {
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
  // Reuse structural and graph validation, including counts and supported fields.
  fromTreeDocument(document, { registry });
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
  const entries = registryEntries(registry);
  const document = record(value, '$');
  fields(document, ['format', 'version', 'kind', 'root', 'nodes'], '$');
  if (document.format !== 'bhtrees') fail('$.format', 'Expected bhtrees');
  if (document.version !== 1) fail('$.version', 'Unsupported schema version; expected 1');
  if (document.kind !== 'tree') fail('$.kind', 'Expected tree');
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
    if (type === 'action' || type === 'condition') {
      fields(data, [...base, 'implementation', 'implementationVersion'], path);
      const name = string(data.implementation, `${path}.implementation`), entry = entries.get(name);
      if (!entry || entry.definition.type !== type) fail(`${path}.implementation`, `Unknown ${type} implementation: ${name}`);
      if (data.implementationVersion !== entry.version) fail(`${path}.implementationVersion`, `Unsupported implementation version; expected ${entry.version}`);
      node = entry.definition.type === 'action' ? nodes.action({ ...entry.definition, ...common })
        : nodes.condition({ ...common, test: entry.definition.test });
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

export function encodeTree(root: NodeDefinition, options: SerializationOptions = {}): string {
  const text = JSON.stringify(toTreeDocument(root, options), null, 2);
  if (text.length > MAX_TEXT) fail('$', 'Document exceeds 1000000 characters');
  return text;
}
export function decodeTree(text: string, options: SerializationOptions = {}): NodeDefinition {
  if (typeof text !== 'string' || text.length > MAX_TEXT) fail('$', 'Expected JSON text of at most 1000000 characters');
  let document: unknown;
  try { document = JSON.parse(text); } catch (error) { fail('$', `Invalid JSON: ${(error as Error).message}`); }
  return fromTreeDocument(document, options);
}
