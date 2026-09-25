import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionLoader, ExtensionError, createRegistry, action, createRunner, encodeTree,
  decodeTree, encodeValue, decodeValue, loadConfiguredTree, resolveTreeConfiguration, SUCCESS, RUNNING } from '../dist/index.js';

const manifest = (id, setup = () => {}, extra = {}) => ({ id, version: '1.0.0', apiVersion: 1, setup, ...extra });
const treeText = (extensions, implementation = 'plugin.run') => JSON.stringify({ format: 'bhtrees', version: 1, kind: 'tree', root: 'root',
  nodes: [{ id: 'root', type: 'action', implementation, implementationVersion: 1 }], config: { extensions } });

test('catalogs reserve built-ins, resolve dependencies and validate all options before setup', async () => {
  const calls = [];
  const base = manifest('base', api => { calls.push('base'); api.registerService('base', 40); return { dispose() { calls.push('dispose base'); } }; });
  const plugin = manifest('plugin', (api, options) => {
    calls.push('plugin'); api.registerAction('plugin.run', { tick: c => c.success(api.getService('base') + options.amount) });
    return { dispose() { calls.push('dispose plugin'); } };
  }, { dependencies: ['base'], validateOptions: options => { calls.push('validate'); if (typeof options.amount !== 'number') throw Error('amount required'); } });
  const loader = createExtensionLoader({ builtins: { base }, catalog: { plugin } });
  const session = await loader.load([{ name: 'plugin', options: { amount: 2 } }]);
  assert.deepEqual(calls, ['validate', 'base', 'plugin']);
  assert.deepEqual(session.snapshot().map(s => s.id), ['base', 'plugin']);
  assert.equal(session.snapshot()[0].location, 'builtin:base');
  assert.equal(createRunner(decodeTree(treeText([], 'plugin.run'), { registry: session.registry })).tick().output, 42);
  const disposal = session.dispose(); assert.equal(session.dispose(), disposal); await disposal;
  assert.deepEqual(calls.slice(-2), ['dispose plugin', 'dispose base']);
  assert.ok(session.snapshot().every(s => s.status === 'disposed'));
  assert.throws(() => createExtensionLoader({ builtins: { base }, catalog: { base } }), /Reserved/);
  calls.length = 0;
  await assert.rejects(loader.load([{ name: 'plugin', options: { amount: 'bad' } }]), /amount required/);
  assert.deepEqual(calls, ['validate']);
});

test('module cache is shared across concurrent sessions but registries and setup are isolated', async () => {
  let imports = 0, setups = 0, cleanups = 0, policies = 0;
  const loader = createExtensionLoader({ catalog: { plugin: 'https://example.test/a/../plugin.js' },
    allowModule: uri => { policies++; return uri === 'https://example.test/plugin.js'; },
    importModule: async () => { imports++; return { default: manifest('plugin', api => {
      const value = ++setups;
      api.registerAction('plugin.run', { tick: c => c.success(value) });
      api.onDispose(() => { cleanups++; });
    }) }; } });
  const seed = createRegistry(), echo = c => c.success(c.input);
  seed.registerAction('echo', { tick: echo });
  seed.registerValue('date', { version: 1, test: v => v instanceof Date, encode: v => v.toISOString(), decode: v => new Date(v) });
  seed.registerNode('custom', { version: 1, create: ({ id, reactive }) => action({ id, reactive, tick: echo }) });
  const [a, b] = await Promise.all([loader.load([{ name: 'plugin' }], { registry: seed }), loader.load([{ name: 'plugin' }], { registry: seed })]);
  assert.equal(imports, 1); assert.equal(setups, 2); assert.equal(policies, 2);
  assert.notEqual(a.registry, b.registry); assert.notEqual(a.registry, seed);
  const values = [a, b].map(s => createRunner(decodeTree(treeText([]), { registry: s.registry })).tick().output);
  assert.deepEqual(values.sort(), [1, 2]);
  assert.throws(() => decodeTree(treeText([]), { registry: seed }), /Unknown action/);
  assert.equal(decodeValue(encodeValue(new Date(0), { registry: seed }), { registry: a.registry }).getTime(), 0);
  assert.equal(createRunner(a.registry.createNode('custom', { id: 'custom', data: null }), { input: 8 }).tick().output, 8);
  await a.dispose(); assert.equal(cleanups, 1); assert.equal(b.snapshot()[0].status, 'ready');
  await b.dispose(); assert.equal(cleanups, 2);
});

test('setup rollback includes partially acquired resources and closes leaked registration APIs', async () => {
  const calls = []; let leaked;
  const seed = createRegistry();
  const loader = createExtensionLoader({ catalog: {
    base: manifest('base', api => { api.onDispose(() => calls.push('base')); }),
    broken: manifest('broken', api => {
      leaked = api; api.registerAction('leaked', { tick: () => SUCCESS });
      api.onDispose(() => { calls.push('broken'); throw Error('cleanup failed'); });
      throw Error('setup failed');
    }, { dependencies: ['base'] })
  } });
  await assert.rejects(loader.load([{ name: 'broken' }], { registry: seed }), error =>
    error instanceof ExtensionError && error.declarationId === 'broken' && error.cause instanceof AggregateError);
  assert.deepEqual(calls, ['broken', 'base']);
  assert.throws(() => leaked.registerCondition('late', () => true), /only available during setup/);
  assert.throws(() => decodeTree(treeText([], 'leaked'), { registry: seed }), /Unknown action/);
});

test('missing, disabled, cyclic and conflicting dependencies fail before setup', async () => {
  let setups = 0;
  for (const [catalog, declarations, pattern] of [
    [{ a: manifest('a', () => setups++, { dependencies: ['missing'] }) }, [{ name: 'a' }], /Unknown extension/],
    [{ a: manifest('a', () => setups++, { dependencies: ['b'] }), b: manifest('b') }, [{ name: 'a' }, { name: 'b', enabled: false }], /disabled/],
    [{ a: manifest('a', () => setups++, { dependencies: ['b'] }), b: manifest('b', () => setups++, { dependencies: ['a'] }) }, [{ name: 'a' }], /cycle/],
    [{ a: manifest('different') }, [{ name: 'a' }], /does not match/],
    [{ a: manifest('a') }, [{ id: 'one', name: 'a' }, { id: 'two', name: 'a' }], /Conflicting manifest/]
  ]) await assert.rejects(createExtensionLoader({ catalog }).load(declarations), pattern);
  assert.equal(setups, 0);
});

test('module policy applies on cache hits and failed module loads can retry', async () => {
  let attempts = 0, allowed = true;
  const loader = createExtensionLoader({ importModule: () => {
    if (++attempts === 1) throw Error('offline'); return manifest('plugin');
  }, allowModule: () => allowed });
  const declarations = [{ path: 'file:///app/plugin.js' }];
  await assert.rejects(loader.load(declarations), error => error.location === 'file:///app/plugin.js' && /offline/.test(error.message));
  const session = await loader.load(declarations); await session.dispose();
  allowed = false;
  await assert.rejects(loader.load(declarations), /denied/);
  assert.equal(attempts, 2);
});

test('manifest, API, option and service validation reject unsupported contracts', async () => {
  for (const value of [manifest('x', () => {}, { apiVersion: 2 }), manifest('x', () => {}, { dependencies: ['x', 'x'] }),
    manifest('x', () => {}, { optionsSchema: {} }), { id: 'x', version: '1', apiVersion: 1 }]) {
    assert.throws(() => createExtensionLoader({ catalog: { x: value } }), TypeError);
  }
  await assert.rejects(createExtensionLoader({ catalog: { x: manifest('x') } }).load([{ name: 'x', options: { ignored: true } }]), /option validator/);
  await assert.rejects(createExtensionLoader().load([{ path: 'https://example.test/x.js' }]), /importModule/);
  for (const setup of [() => 1, api => { api.registerService('x', 1); api.registerService('x', 2); }, api => api.onDispose(null)]) {
    await assert.rejects(createExtensionLoader({ catalog: { x: manifest('x', setup) } }).load([{ name: 'x' }]), ExtensionError);
  }
});

test('configured loader installs extension nodes/services and cancels runners before disposal', async () => {
  const calls = [];
  const extensionLoader = createExtensionLoader({ catalog: { plugin: manifest('plugin', api => {
    api.registerService('counter', { value: 0 });
    api.registerAction('plugin.run', { tick: c => { c.services.counter.value++; return RUNNING; }, cancel: () => calls.push('cancel') });
    return { dispose() { calls.push('dispose'); } };
  }) } });
  const text = treeText([{ name: 'plugin' }]);
  const config = await resolveTreeConfiguration(text, { extensionLoader });
  assert.equal(config.config.extensions[0].name, 'plugin'); assert.deepEqual(calls, []);
  const loaded = await loadConfiguredTree(text, { extensionLoader });
  assert.equal(loaded.extensionSnapshot()[0].status, 'ready');
  assert.ok(encodeTree(loaded.tree, { registry: loaded.registry }).includes('plugin.run'));
  const runner = loaded.createRunner(); runner.tick();
  assert.throws(() => loaded.createRunner({ services: { counter: {} } }), /conflicts/);
  const disposal = loaded.dispose(); assert.equal(disposal, loaded.dispose()); await disposal;
  assert.deepEqual(calls, ['cancel', 'dispose']); assert.equal(runner.snapshot().status, 'cancelled');
  assert.throws(() => loaded.createRunner(), /disposed/);
});

test('failed tree validation rolls back setup and malformed graph never imports modules', async () => {
  let imports = 0, setups = 0, disposals = 0;
  const extensionLoader = createExtensionLoader({ catalog: { plugin: 'file:///plugin.js' }, importModule: () => {
    imports++; return manifest('plugin', () => { setups++; return { dispose() { disposals++; } }; });
  } });
  await assert.rejects(loadConfiguredTree(treeText([{ name: 'plugin' }]), { extensionLoader }), /Unknown action/);
  assert.equal(setups, 1); assert.equal(disposals, 1);
  const invalid = JSON.parse(treeText([{ name: 'plugin' }])); invalid.root = 'missing';
  await assert.rejects(loadConfiguredTree(JSON.stringify(invalid), { extensionLoader }), /Unknown node reference/);
  assert.equal(imports, 1); assert.equal(setups, 1);
});

test('configured disposal reports cancellation failures and still disposes extensions', async () => {
  let cleaned = 0;
  const extensionLoader = createExtensionLoader({ catalog: { plugin: manifest('plugin', api => {
    api.registerAction('plugin.run', { tick: () => RUNNING, cancel: () => { throw Error('cancel failed'); } });
    return { dispose() { cleaned++; } };
  }) } });
  const loaded = await loadConfiguredTree(treeText([{ name: 'plugin' }]), { extensionLoader });
  loaded.createRunner().tick();
  await assert.rejects(loaded.dispose(), AggregateError);
  assert.equal(cleaned, 1);
});
