import { action, sequence, selector, condition, inverter, forceSuccess, forceFailure, retry, repeat, delay, timeout, cooldown, subtree, parallel, createRegistry, encodeTree, decodeTree, toTreeDocument, fromTreeDocument, encodeValue, decodeValue, toPortableValue, fromPortableValue, createBlackboard, createRunner, SUCCESS, RUNNING } from 'bhtrees';
import type { ActionImplementation, ActionContext, Clock, NodeDefinition, RunnerSnapshot, WaitDescriptor } from 'bhtrees';
import type { NodeFactory, NodeFactoryOptions, CreateNodeOptions } from 'bhtrees';
import { parseYaml, stringifyYaml, YamlError } from 'bhtrees';
import type { YamlValue } from 'bhtrees';
import { encodeConfig, decodeConfig, toConfigDocument, fromConfigDocument, resolveConfiguration, loadConfiguredTree, resolveTreeConfiguration } from 'bhtrees';
import type { Configuration, ExtensionDeclaration, ResolvedExtension, ConfiguredTree, ConfigFileContent, TreeSerializationOptions } from 'bhtrees';
import { createExtensionLoader } from 'bhtrees';
import type { ExtensionManifest } from 'bhtrees';
import { createDebugger } from 'bhtrees';
import type { DebugSnapshot, DebugCommandResult } from 'bhtrees';
const debugClient = createDebugger(createRunner(action({ id: 'debug', tick: () => RUNNING })));
const debugResult: DebugCommandResult = debugClient.command({ type: 'select', activationId: null });
debugClient.subscribe((snapshot: DebugSnapshot) => { void snapshot.selection; });
// @ts-expect-error Unsupported command is not advertised by the client.
debugClient.command({ type: 'stepOver' });
void debugResult;
import { loadAdventureLandSession } from 'bhtrees/adventure-land';
import type { AdventureLandSession } from 'bhtrees/adventure-land';
const gameSession: Promise<AdventureLandSession> = loadAdventureLandSession('al://slots/tree.json', {
  host: { readDocument: () => ({ text: '{}', codec: 'json' }), services: { character: {} } }
});
void gameSession;
import { loadBrowserTree, createBrowserExtensionLoader, readBrowserConfig } from 'bhtrees/browser';
const browserTree: Promise<ConfiguredTree> = loadBrowserTree('./mission.yaml', { baseURI: 'https://example.test/app/' });
const browserConfig: Promise<ConfigFileContent> = readBrowserConfig('https://example.test/config.json');
createBrowserExtensionLoader({ baseURI: 'https://example.test/', catalog: { plugin: './plugin.js' } });
void browserTree; void browserConfig;
import { createNodeExtensionLoader, loadNodeTree, toFileURI, readNodeConfig } from 'bhtrees/node';
const nodeLoader = createNodeExtensionLoader({ baseURI: new URL('file:///app/mission.json'), packages: { plugin: 'example-plugin' } });
const nodeTree: Promise<ConfiguredTree> = loadNodeTree('./mission.yaml', { extensionLoader: nodeLoader });
const nodeFile: Promise<ConfigFileContent> = readNodeConfig(toFileURI('./mission.yaml'));
void nodeTree; void nodeFile;
const exampleManifest: ExtensionManifest = {
  id: 'example', version: '1.0.0', apiVersion: 1,
  setup(api) {
    api.registerAction('example.run', { tick: () => SUCCESS });
    api.registerValue('example.date', { version: 1, test: (value): value is Date => value instanceof Date,
      encode: date => date.toISOString(), decode: data => new Date(String(data)) });
    api.onDispose(async () => {});
    return { dispose() {} };
  }
};
const exampleExtensionLoader = createExtensionLoader({ catalog: { example: exampleManifest } });
void exampleExtensionLoader;

const extension: ExtensionDeclaration = { id: 'combat', path: './combat.js', enabled: false, options: { radius: 5 } };
const extensionConfig: Configuration = { extensions: [extension, { name: 'metrics' }] };
const extensions = resolveConfiguration([{ config: extensionConfig, source: { layer: 'example', uri: 'file:///app/config.yaml' } }]);
const resolvedExtension: ResolvedExtension = extensions.config.extensions[0];
// @ts-expect-error Resolved extension flags are readonly.
resolvedExtension.enabled = true;
// @ts-expect-error Resolved extension option records are readonly.
resolvedExtension.options.radius = 8;
// @ts-expect-error A declaration requires exactly one of name and path.
const ambiguousExtension: ExtensionDeclaration = { name: 'combat', path: './combat.js' };
// @ts-expect-error ID-only declarations cannot identify a source.
const missingExtensionSource: ExtensionDeclaration = { id: 'combat', enabled: false };
void ambiguousExtension; void missingExtensionSource;
void resolveTreeConfiguration('{}', { config: extensionConfig, configBaseURI: 'file:///app/config.yaml' });

const configuration: Configuration = { runtime: { maxStepsPerTick: 10, errorPolicy: 'stop' }, blackboard: { enabled: true, initial: { count: 0 } } };
const configText: string = encodeConfig(configuration, { codec: 'yaml' });
decodeConfig(configText, { codec: 'yaml' });
fromConfigDocument(toConfigDocument(configuration));
const resolution = resolveConfiguration([{ config: configuration, source: { layer: 'application' } }]);
// @ts-expect-error Resolved settings are immutable.
resolution.config.runtime.maxStepsPerTick = 2;
// @ts-expect-error Only the implemented error policy is accepted.
const unsupportedPolicy: Configuration = { runtime: { errorPolicy: 'ignore' } };
const treeOptions: TreeSerializationOptions = { codec: 'yaml', config: configuration, configFile: './settings.yaml' };
void unsupportedPolicy; void treeOptions;
async function configuredConsumer(text: string) {
  const loaded: ConfiguredTree = await loadConfiguredTree(text, { codec: 'yaml', baseURI: 'https://example.test/tree.yaml',
    readConfig: async (): Promise<ConfigFileContent> => ({ text: configText, codec: 'yaml' }), overrides: configuration });
  loaded.createRunner({ input: 'example', services: {} }).tick();
  // @ts-expect-error Budget settings go through configuration overrides for provenance.
  loaded.createRunner({ maxStepsPerTick: 1 });
}
void configuredConsumer;

const yamlData: YamlValue = parseYaml('name: rover');
const yamlText: string = stringifyYaml(yamlData);
const yamlTree = decodeTree(yamlText, { codec: 'yaml' });
encodeTree(yamlTree, { codec: 'yaml' });
decodeValue(encodeValue({ example: true }, { codec: 'yaml' }), { codec: 'yaml' });
const yamlError = new YamlError(1, 2, 'example');
const yamlLine: number = yamlError.line;
void yamlLine;
// @ts-expect-error Only the built-in JSON and YAML codecs are available.
decodeTree(yamlText, { codec: 'xml' });

const factoryRegistry = createRegistry();
const factory: NodeFactory = { version: 2, migrations: { 1: data => ({ value: data }) },
  create(options: NodeFactoryOptions) {
    // @ts-expect-error Factory data requires application validation/narrowing.
    options.data.value;
    // @ts-expect-error The child array is readonly.
    options.children.push(action({ id: 'extra', tick: () => SUCCESS }));
    return sequence({ id: options.id, reactive: options.reactive,
      steps: options.children.map(node => ({ node })) });
  }
};
factoryRegistry.registerNode('application.sequence', factory);
const factoryOptions: CreateNodeOptions = { id: 'custom', data: null, children: [] };
const customDefinition: NodeDefinition = factoryRegistry.createNode('application.sequence', factoryOptions);
void customDefinition;
// @ts-expect-error Factories must return a synchronous definition.
factoryRegistry.registerNode('async', { version: 1, create: async () => sequence({ id: 'bad', steps: [] }) });

const clock: Clock = { setTimeout: () => ({ id: 1 }), clearTimeout: handle => { void handle; } };
const work = action({
  id: 'work',
  enter(ctx) {
    const wait: WaitDescriptor = ctx.wait.all([
      ctx.wait.promise(Promise.resolve(1)),
      ctx.wait.timer(5, { value: 'elapsed' }),
      ctx.wait.event(notify => { notify('ready'); return () => {}; }),
      ctx.wait.poll(() => true)
    ], { resume: 'done' });
    return wait;
  },
  resume: { done: (ctx, values) => ctx.success(values) },
  cancel: (ctx, reason) => { ctx.local.reason = reason; }
});
const tree: NodeDefinition = sequence({ id: 'root', reactive: true, steps: [
  { node: work, save: 'result', input: scope => scope.input },
  { node: action({ id: 'tick', tick: ctx => ctx.local.ready ? SUCCESS : RUNNING }) }
], output: scope => scope.vars.result });
const runner = createRunner(tree, { clock, input: { name: 'agent' } });
const snapshot: RunnerSnapshot = runner.tick();
runner.step(); runner.pause(); runner.continue(); runner.cancel();
if (snapshot.frames[0]) {
  // @ts-expect-error Snapshot structures are readonly.
  snapshot.frames[0].phase = 'enter';
}
// @ts-expect-error An action must have exactly one execution callback.
action({ id: 'invalid', enter: () => SUCCESS, tick: () => SUCCESS });
// @ts-expect-error Action results must use supported statuses.
action({ id: 'invalid-result', tick: () => 'finished' });
// @ts-expect-error Reactivity has three supported settings.
sequence({ id: 'invalid-reactive', steps: [], reactive: 'always' });
function invalidWait(ctx: ActionContext) {
  // @ts-expect-error Event subscriptions must return a disposer.
  ctx.wait.event(() => {});
  // @ts-expect-error Timer delay is numeric.
  ctx.wait.timer('soon');
}
void invalidWait;

const priority: NodeDefinition = selector({ id: 'priority', reactive: true, steps: [
  { node: condition({ id: 'ready', test: ctx => ctx.input.ready === true }) },
  { node: tree, save: 'fallback' }
], output: scope => scope.last });
createRunner(priority);
// @ts-expect-error Conditions must return boolean values synchronously.
condition({ id: 'async', test: async () => true });
// @ts-expect-error Conditions cannot return behavior statuses.
condition({ id: 'status', test: () => SUCCESS });
condition({ id: 'no-wait', test: ctx => {
  // @ts-expect-error Conditions cannot register waits.
  ctx.wait.timer(1);
  return true;
} });
// @ts-expect-error Selectors require node definitions in their steps.
selector({ id: 'invalid-step', steps: [{ node: {} }] });

const decorated: NodeDefinition = inverter({ id: 'invert', child: forceSuccess({ id: 'success',
  child: forceFailure({ id: 'failure', reactive: false, child: priority }) }) });
createRunner(decorated);
// @ts-expect-error Decorators require one child definition.
inverter({ id: 'missing-child' });
// @ts-expect-error Decorators accept one child, not a steps array.
forceSuccess({ id: 'many', steps: [{ node: tree }] });
// @ts-expect-error Decorator children must be node definitions.
forceFailure({ id: 'invalid-child', child: {} });

createRunner(retry({ id: 'retry', child: decorated, attempts: 3 }));
createRunner(repeat({ id: 'repeat', child: decorated, times: Infinity }));
const completed: number | undefined = snapshot.frames[0]?.completedIterations;
void completed;
// @ts-expect-error Retry requires an explicit total-attempt limit.
retry({ id: 'missing-limit', child: tree });
// @ts-expect-error Repeat requires a numeric iteration count.
repeat({ id: 'bad-limit', child: tree, times: 'forever' });

createRunner(delay({ id: 'delay', ms: 20, child: tree }));
createRunner(timeout({ id: 'timeout', ms: 100, child: decorated }));
createRunner(cooldown({ id: 'cooldown', ms: 50, child: priority }));
// @ts-expect-error Timed decorators require an explicit duration.
delay({ id: 'missing-duration', child: tree });
// @ts-expect-error Durations are numbers, not strings.
timeout({ id: 'bad-duration', ms: '100', child: tree });
// @ts-expect-error Cooldown wraps a node definition.
cooldown({ id: 'bad-child', ms: 10, child: {} });

createRunner(subtree({ id: 'call', child: tree, input: scope => scope.input,
  output: (scope, result) => {
    // @ts-expect-error Subtree output mappings cannot change the child status.
    result.status = 'SUCCESS';
    return { value: scope.last, status: result.status };
  }
}));
const parentId: number | null = snapshot.frames[0].parentActivationId;
void parentId;
// @ts-expect-error Subtree input bindings are functions.
subtree({ id: 'invalid-input', child: tree, input: 42 });
// @ts-expect-error Subtree calls require a child definition.
subtree({ id: 'missing-definition' });

createRunner(parallel({ id: 'parallel', successThreshold: 2, failureThreshold: 1,
  steps: [{ node: tree }, { node: decorated, input: scope => scope.input }],
  output: (results, status) => {
    // @ts-expect-error Parallel completion arrays are readonly.
    results[0] = undefined;
    return { status, values: results.map(result => result?.output) };
  }
}));
// @ts-expect-error Parallel requires explicit thresholds.
parallel({ id: 'missing-policy', steps: [{ node: tree }] });
parallel({ id: 'invalid-save', successThreshold: 1, failureThreshold: 1,
  // @ts-expect-error Parallel outputs require a reducer instead of shared saves.
  steps: [{ node: tree, save: 'collision' }]
});

const board = createBlackboard({ count: 0 });
const unsubscribe = board.subscribe(change => {
  const revision: number = change.revision;
  // @ts-expect-error Change records are readonly.
  change.key = 'changed';
  void revision;
});
board.set('count', board.get('count') + 1);
board.has('count'); board.delete('count'); unsubscribe();
createRunner(condition({ id: 'board-condition', test: ctx => ctx.blackboard?.has('ready') ?? false }), { blackboard: board });
// @ts-expect-error Blackboard keys must be strings.
board.set(42, 'value');
// @ts-expect-error Snapshot containers are readonly.
board.snapshot().values.count = 1;
// @ts-expect-error Runner board injection must implement the blackboard API.
createRunner(tree, { blackboard: {} });

action({ id: 'callback', enter(ctx) {
  const token = ctx.wait.callback({ resume: 'done', reject: 'failed' });
  const accepted: boolean = token.resolve(42);
  token.reject(new Error('ignored after resolution'));
  void accepted;
  // @ts-expect-error Callback tokens are handles, not wait descriptors.
  ctx.wait.any([token]);
  return token.wait;
}, resume: { done: (ctx, value) => ctx.success(value), failed: (ctx, error) => ctx.failure(error) } });

const pathTree = sequence({ id: 'paths', steps: [
  { node: tree, input: { path: ['input', 'items', 0] }, save: 'value' }
], output: { path: ['vars', 'value'] } });
createRunner(subtree({ id: 'path-call', child: pathTree, output: { path: ['result', 'output'] } }));
createRunner(parallel({ id: 'path-parallel', steps: [{ node: pathTree }],
  successThreshold: 1, failureThreshold: 1, output: { path: ['results', 0, 'output'] } }));
// @ts-expect-error Declarative paths are segment arrays, not expressions.
sequence({ id: 'bad-path', steps: [], output: { path: 'vars.value' } });
// @ts-expect-error Path segments are strings or numbers.
subtree({ id: 'bad-segment', child: tree, input: { path: [true] } });

const registry = createRegistry();
const implementation: ActionImplementation = { tick: () => SUCCESS };
registry.registerAction('app.success', implementation, 1);
registry.registerCondition('app.ready', ctx => ctx.input === true);
const portable = action({ id: 'portable', ...implementation });
createRunner(decodeTree(encodeTree(portable, { registry }), { registry }));
fromTreeDocument(toTreeDocument(portable, { registry }), { registry });
// @ts-expect-error Action implementations require enter or tick.
registry.registerAction('app.invalid', {});
// @ts-expect-error Conditions are synchronous boolean predicates.
registry.registerCondition('app.async', async () => true);

registry.registerValue<Date>('date', {
  version: 2,
  test: (value): value is Date => value instanceof Date,
  encode: date => date.toISOString(),
  decode: data => { if (typeof data !== 'string') throw new TypeError('Expected string'); return new Date(data); },
  migrations: { 1: data => String(data) }
});
const portableValue = toPortableValue(new Date(), { registry });
const unknownValue: unknown = fromPortableValue(portableValue, { registry });
decodeValue(encodeValue(unknownValue, { registry }), { registry });
// @ts-expect-error Codecs require a decoder.
registry.registerValue('missing-decoder', { version: 1, test: (v): v is Date => v instanceof Date, encode: date => date.toISOString() });
