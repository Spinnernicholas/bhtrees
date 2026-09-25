import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, createRegistry, createRunner, encodeTree, decodeTree, toTreeDocument,
  toConfigDocument, fromConfigDocument, encodeConfig, decodeConfig, resolveConfiguration,
  loadConfiguredTree, DocumentError, SUCCESS } from '../dist/index.js';

const plain = value => JSON.parse(JSON.stringify(value));
const at = path => error => error instanceof DocumentError && error.path === path;
function setup() {
  const registry = createRegistry();
  const tick = ctx => {
    if (!ctx.blackboard) return ctx.success('disabled');
    const state = ctx.blackboard.get('state');
    state.count++;
    ctx.blackboard.set('last', ctx.input);
    return ctx.success(state.count);
  };
  registry.registerAction('read', { tick });
  return { registry, tree: sequence({ id: 'root', steps: [{ node: action({ id: 'read', tick }) }] }) };
}

test('configuration documents round trip with equivalent JSON and YAML data', () => {
  const config = { runtime: { maxStepsPerTick: 12, errorPolicy: 'stop' },
    blackboard: { enabled: true, initial: { a: [1, null, true], nested: { text: 'hello' } } } };
  for (const codec of ['json', 'yaml']) {
    assert.deepEqual(plain(decodeConfig(encodeConfig(config, { codec }), { codec })), config);
    assert.deepEqual(plain(fromConfigDocument(toConfigDocument(config))), config);
  }
  assert.throws(() => encodeConfig(config, { codec: 'xml' }), at('$codec'));
  assert.throws(() => decodeConfig('', { codec: 'xml' }), at('$codec'));
});

test('configuration rejects unknown settings, invalid types, accessors and recursive references', () => {
  for (const [config, path] of [
    [{ other: true }, '$.config.other'], [{ runtime: null }, '$.config.runtime'],
    [{ runtime: { maxStepsPerTick: 0 } }, '$.config.runtime.maxStepsPerTick'],
    [{ runtime: { maxStepsPerTick: Infinity } }, '$.config.runtime.maxStepsPerTick'],
    [{ runtime: { errorPolicy: 'ignore' } }, '$.config.runtime.errorPolicy'],
    [{ blackboard: { enabled: 1 } }, '$.config.blackboard.enabled'],
    [{ blackboard: { initial: [] } }, '$.config.blackboard.initial'],
    [{ debugger: { enabled: true } }, '$.config.debugger'],
    [{ extensions: null }, '$.config.extensions'],
    [{ runtime: { maxStepsPerTick: undefined } }, '$.config.runtime.maxStepsPerTick']
  ]) assert.throws(() => toConfigDocument(config), at(path));
  const accessor = Object.defineProperty({}, 'enabled', { get() { throw Error('getter ran'); } });
  assert.throws(() => toConfigDocument({ blackboard: accessor }), at('$.config.blackboard'));
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => encodeConfig({ blackboard: { initial: cycle } }), /Cyclic/);
  for (const value of [undefined, new Date(), NaN, -0, () => {}, [1, , 2]]) {
    assert.throws(() => toConfigDocument({ blackboard: { initial: { value } } }), DocumentError);
  }
  for (const mutate of [d => d.version = 2, d => d.kind = 'tree', d => d.configFile = './recursive.json', d => delete d.config]) {
    const document = toConfigDocument({}); mutate(document);
    assert.throws(() => fromConfigDocument(document), DocumentError);
  }
  assert.throws(() => decodeConfig('x'.repeat(1000001)), /1000000/);
  let nested = null; for (let i = 0; i < 130; i++) nested = { nested };
  assert.throws(() => toConfigDocument({ blackboard: { initial: nested } }), /depth/);
});

test('layer merging preserves leaf provenance, replaces arrays and treats null as data', () => {
  const first = { blackboard: { enabled: true, initial: { nested: { a: 1, b: 2 }, list: [1, 2], replace: { old: true }, 'a/b~c': 3 } } };
  const second = { blackboard: { initial: { nested: { a: 5 }, list: [3], replace: null } }, runtime: { maxStepsPerTick: 3 } };
  const resolved = resolveConfiguration([
    { config: first, source: { layer: 'first', uri: 'file:///first.yaml' } },
    { config: second, source: { layer: 'second' } }
  ]);
  assert.deepEqual(plain(resolved.config.blackboard.initial), { nested: { a: 5, b: 2 }, list: [3], replace: null, 'a/b~c': 3 });
  assert.deepEqual(resolved.provenance['/blackboard/initial/nested/b'], { layer: 'first', uri: 'file:///first.yaml' });
  assert.equal(resolved.provenance['/blackboard/initial/nested/a'].layer, 'second');
  assert.equal(resolved.provenance['/blackboard/initial/a~1b~0c'].layer, 'first');
  assert.equal(resolved.provenance['/runtime/errorPolicy'].layer, 'defaults');
  assert.equal(resolved.provenance['/blackboard/initial/replace/old'], undefined);
  assert.equal(resolved.provenance['/blackboard/initial'], undefined);
  first.blackboard.initial.nested.b = 8;
  assert.equal(resolved.config.blackboard.initial.nested.b, 2);
  assert.throws(() => { resolved.config.blackboard.initial.nested.b = 9; }, TypeError);
  assert.throws(() => { resolved.provenance['/runtime/errorPolicy'].layer = 'changed'; }, TypeError);
});

test('defaults and special keys are safe, and empty maps merge without clearing', () => {
  const defaults = resolveConfiguration();
  assert.deepEqual(plain(defaults.config), { runtime: { maxStepsPerTick: 1000, errorPolicy: 'stop' }, blackboard: { enabled: false, initial: {} }, extensions: [] });
  const resolved = resolveConfiguration([
    { config: { blackboard: { initial: JSON.parse('{"__proto__":{"polluted":true},"constructor":5}') } }, source: { layer: 'initial' } },
    { config: { blackboard: { initial: {} } }, source: { layer: 'empty' } }
  ]);
  assert.equal(Object.getPrototypeOf(resolved.config.blackboard.initial), null);
  assert.equal(resolved.config.blackboard.initial.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
  assert.equal(resolved.provenance['/blackboard/initial/constructor'].layer, 'initial');
});

test('tree config metadata survives JSON/YAML definition round trips without applying it', () => {
  const { registry, tree } = setup();
  for (const codec of ['json', 'yaml']) {
    const text = encodeTree(tree, { registry, codec, config: { runtime: { maxStepsPerTick: 1 } }, configFile: './settings.yaml' });
    const loaded = decodeTree(text, { registry, codec });
    const document = toTreeDocument(loaded, { registry });
    assert.equal(document.configFile, './settings.yaml');
    assert.equal(document.config.runtime.maxStepsPerTick, 1);
    assert.equal(createRunner(loaded).tick().status, SUCCESS);
    document.config.runtime.maxStepsPerTick = 99;
    assert.equal(toTreeDocument(loaded, { registry }).config.runtime.maxStepsPerTick, 1);
  }
  assert.throws(() => encodeTree(tree, { registry, config: null }), at('$.config'));
  assert.throws(() => encodeTree(tree, { registry, configFile: '' }), at('$.configFile'));
});

test('configured loading resolves precedence, source URI, budget and isolated runner blackboards', async () => {
  const { registry, tree } = setup();
  const text = encodeTree(tree, { registry, codec: 'yaml', configFile: '../config/settings.yaml',
    config: { runtime: { maxStepsPerTick: 20 }, blackboard: { enabled: true, initial: { state: { count: 0 }, embedded: true } } } });
  const requested = [];
  const loaded = await loadConfiguredTree(text, { registry, codec: 'yaml', baseURI: 'https://example.test/trees/mission.yaml',
    readConfig: uri => { requested.push(uri); return { codec: 'yaml', text: encodeConfig({ runtime: { maxStepsPerTick: 10 }, blackboard: { initial: { file: 1 } } }, { codec: 'yaml' }) }; },
    config: { runtime: { maxStepsPerTick: 30 }, blackboard: { initial: { explicit: 2 } } },
    overrides: { runtime: { maxStepsPerTick: 1 } }
  });
  assert.deepEqual(requested, ['https://example.test/config/settings.yaml']);
  assert.equal(loaded.provenance['/blackboard/initial/file'].uri, requested[0]);
  assert.equal(loaded.provenance['/blackboard/initial/embedded'].layer, 'embedded');
  assert.equal(loaded.provenance['/blackboard/initial/explicit'].layer, 'explicit');
  assert.equal(loaded.provenance['/runtime/maxStepsPerTick'].layer, 'overrides');
  const a = loaded.createRunner({ input: 'a' }), b = loaded.createRunner({ input: 'b' });
  assert.equal(a.tick().transitions, 1);
  for (let i = 0; i < 10 && a.snapshot().status !== SUCCESS; i++) a.tick();
  for (let i = 0; i < 10 && b.snapshot().status !== SUCCESS; i++) b.tick();
  assert.equal(a.snapshot().output, 1); assert.equal(b.snapshot().output, 1);
  assert.equal(loaded.config.blackboard.initial.state.count, 0);
  assert.throws(() => loaded.createRunner({ maxStepsPerTick: 100 }), /configuration overrides/);
});

test('disabled blackboards remain absent and config-only loading never performs I/O', async () => {
  const { registry, tree } = setup();
  const loaded = await loadConfiguredTree(encodeTree(tree, { registry }), { registry,
    readConfig: () => { throw Error('unexpected I/O'); }, config: { blackboard: { enabled: false, initial: { unused: 1 } } } });
  assert.equal(loaded.createRunner().tick().output, 'disabled');
});

test('reference failures are contextual and invalid trees/configs fail before factories or I/O', async () => {
  const registry = createRegistry(); let calls = 0, reads = 0;
  registry.registerNode('custom', { version: 1, create: ({ id, reactive }) => { calls++; return action({ id, reactive, tick: () => SUCCESS }); } });
  const tree = registry.createNode('custom', { id: 'root', data: null }); calls = 0;
  const text = encodeTree(tree, { registry, configFile: './config.yaml' });
  await assert.rejects(loadConfiguredTree(text, { registry }), at('$.configFile'));
  await assert.rejects(loadConfiguredTree(text, { registry, baseURI: 'relative' }), at('$options.baseURI'));
  const opts = { registry, baseURI: 'file:///trees/mission.json', readConfig: () => { reads++; throw Error('offline'); } };
  await assert.rejects(loadConfiguredTree(text, opts), /file:\/\/\/trees\/config.yaml.*offline/);
  const invalid = JSON.parse(text); invalid.root = 'missing';
  await assert.rejects(loadConfiguredTree(JSON.stringify(invalid), opts), /Unknown node/);
  await assert.rejects(loadConfiguredTree(text, { ...opts, overrides: { runtime: { errorPolicy: 'ignore' } } }), /Only stop/);
  assert.equal(reads, 1); assert.equal(calls, 0);
  await assert.rejects(loadConfiguredTree(text, { ...opts, readConfig: () => ({ text: '{', codec: 'json' }) }), /config.yaml.*Invalid JSON/);
  await assert.rejects(loadConfiguredTree(text, { ...opts, readConfig: () => ({ text: '{}', codec: 'xml' }) }), /readConfig must return/);
});

test('explicit layers are captured before asynchronous config reads settle', async () => {
  const { registry, tree } = setup();
  const config = { runtime: { maxStepsPerTick: 7 } };
  let finish;
  const pending = loadConfiguredTree(encodeTree(tree, { registry, configFile: 'file:///settings.json' }), {
    registry, config, readConfig: () => new Promise(resolve => { finish = resolve; })
  });
  config.runtime.maxStepsPerTick = 99;
  finish({ codec: 'json', text: encodeConfig({}) });
  assert.equal((await pending).config.runtime.maxStepsPerTick, 7);
});
