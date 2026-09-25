import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, action, encodeTree, encodeConfig, decodeConfig, toConfigDocument,
  resolveConfiguration, resolveTreeConfiguration, loadConfiguredTree, DocumentError, SUCCESS } from '../dist/index.js';

const plain = value => JSON.parse(JSON.stringify(value));
const layer = (extensions, name = 'application', uri) => ({ config: { extensions }, source: { layer: name, ...(uri ? { uri } : {}) } });

test('extension declarations round trip in JSON/YAML without resolving paths or acquiring modules', () => {
  const config = { extensions: [{ name: 'metrics', options: { flags: [true, null] } },
    { id: 'combat', path: './combat.js', enabled: false, options: {} }] };
  for (const codec of ['json', 'yaml']) assert.deepEqual(plain(decodeConfig(encodeConfig(config, { codec }), { codec })), config);
});

test('extension identity merges preserve order, defaults, disabled state and option provenance', () => {
  const resolved = resolveConfiguration([
    layer([{ name: 'metrics', options: { nested: { a: 1, b: 2 }, list: [1, 2] } }, { id: 'combat', name: 'combat', enabled: false }], 'file', 'file:///app/config.yaml'),
    layer([{ name: 'metrics', options: { nested: { a: 3 }, list: [4] } }, { id: 'combat', name: 'combat', options: { radius: 8 } }, { name: 'extra' }], 'embedded'),
    layer([], 'empty')
  ]);
  assert.deepEqual(plain(resolved.config.extensions), [
    { id: 'metrics', name: 'metrics', enabled: true, options: { nested: { a: 3, b: 2 }, list: [4] } },
    { id: 'combat', name: 'combat', enabled: false, options: { radius: 8 } },
    { id: 'extra', name: 'extra', enabled: true, options: {} }
  ]);
  assert.equal(resolved.provenance['/extensions/0/options/nested/a'].layer, 'embedded');
  assert.equal(resolved.provenance['/extensions/0/options/nested/b'].layer, 'file');
  assert.equal(resolved.provenance['/extensions/0/options/list'].layer, 'embedded');
  assert.equal(resolved.provenance['/extensions/0/enabled'].layer, 'defaults');
  assert.equal(resolved.provenance['/extensions/1/enabled'].layer, 'file');
  assert.equal(resolved.provenance['/extensions/1/name'].layer, 'embedded');
  assert.equal(resolved.provenance['/extensions'], undefined);
  assert.throws(() => { resolved.config.extensions[0].options.nested.a = 9; }, TypeError);
  const enabled = resolveConfiguration([layer([{ name: 'x', enabled: false }]), layer([{ name: 'x', enabled: true }], 'override')]);
  assert.equal(enabled.config.extensions[0].enabled, true);
});

test('canonical path identities resolve against each declaring source before merging', () => {
  const resolved = resolveConfiguration([
    layer([{ path: './plugins/../combat.js', options: { a: 1 } }], 'file', 'https://example.test/config/settings.yaml'),
    layer([{ path: '../config/combat.js', enabled: false }], 'embedded', 'https://example.test/trees/mission.yaml'),
    layer([{ path: './combat.js' }], 'other', 'https://example.test/other/settings.yaml')
  ]);
  assert.equal(resolved.config.extensions.length, 2);
  assert.equal(resolved.config.extensions[0].id, 'https://example.test/config/combat.js');
  assert.equal(resolved.config.extensions[0].path, resolved.config.extensions[0].id);
  assert.equal(resolved.config.extensions[0].enabled, false);
  assert.equal(resolved.provenance['/extensions/0/path'].uri, 'https://example.test/trees/mission.yaml');
  assert.equal(resolved.provenance['/extensions/0/options/a'].uri, 'https://example.test/config/settings.yaml');
  assert.equal(resolved.config.extensions[1].path, 'https://example.test/other/combat.js');
  const absolute = resolveConfiguration([layer([{ path: 'file:///C:/plugins/combat.js' }])]);
  assert.equal(absolute.config.extensions[0].path, 'file:///C:/plugins/combat.js');
});

test('duplicate IDs, conflicting targets and invalid declarations fail explicitly', () => {
  for (const extensions of [null, {}, [{}], [{ id: 'x', enabled: false }], [{ name: 'x', path: './x' }],
    [{ name: '' }], [{ path: ' ' }], [{ name: 'x', id: '' }], [{ name: 'x', enabled: null }],
    [{ name: 'x', options: [] }], [{ name: 'x', unknown: 1 }], [{ name: 'x' }, { name: 'x' }],
    [{ id: 'x', name: 'one' }, { id: 'x', name: 'two' }], [{ path: './x' }, { path: './x' }]]) {
    assert.throws(() => toConfigDocument({ extensions }), DocumentError);
  }
  assert.throws(() => resolveConfiguration([layer([{ path: './a/../x.js' }, { path: './x.js' }], 'file', 'file:///app/config.yaml')]), /Duplicate resolved/);
  assert.throws(() => resolveConfiguration([layer([{ id: 'x', name: 'one' }]), layer([{ id: 'x', name: 'two' }])]), /Conflicting extension source/);
  assert.throws(() => resolveConfiguration([layer([{ id: 'x', path: 'file:///one.js' }]), layer([{ id: 'x', path: 'file:///two.js' }])]), /Conflicting extension source/);
  assert.throws(() => resolveConfiguration([layer([{ path: './relative.js', enabled: false }])]), /declaring URI/);
  assert.throws(() => resolveConfiguration([layer([{ path: 'C:\\plugins\\x.js' }])]), /file URLs/);
  const accessor = Object.defineProperty({}, 'name', { enumerable: true, get() { throw Error('must not execute'); } });
  assert.throws(() => toConfigDocument({ extensions: [accessor] }), /data properties/);
  const oversized = Array.from({ length: 1001 }, (_, i) => ({ name: String(i) }));
  assert.throws(() => toConfigDocument({ extensions: oversized }), /1000/);
  assert.throws(() => resolveConfiguration([layer(oversized.slice(0, 600)), layer(oversized.slice(600))]), /Too many resolved/);
});

test('special option keys are safe and replacing options removes obsolete provenance', () => {
  const first = JSON.parse('{"__proto__":{"safe":true},"a/b~c":{"old":1}}');
  const resolved = resolveConfiguration([layer([{ name: '__proto__', options: first }], 'first'),
    layer([{ name: '__proto__', options: { 'a/b~c': null } }], 'second')]);
  assert.equal(resolved.config.extensions[0].options.__proto__.safe, true);
  assert.equal({}.safe, undefined);
  assert.equal(resolved.provenance['/extensions/0/options/a~1b~0c/old'], undefined);
  assert.equal(resolved.provenance['/extensions/0/options/a~1b~0c'].layer, 'second');
  first.__proto__.safe = false;
  assert.equal(resolved.config.extensions[0].options.__proto__.safe, true);
});

test('tree configuration resolves file, embedded, explicit and override declaration locations without factories', async () => {
  const registry = createRegistry(); let creates = 0;
  registry.registerNode('root', { version: 1, create: ({ id, reactive }) => { creates++; return action({ id, reactive, tick: () => SUCCESS }); } });
  const tree = registry.createNode('root', { id: 'root', data: null }); creates = 0;
  const text = encodeTree(tree, { registry, codec: 'yaml', configFile: '../config/settings.yaml',
    config: { extensions: [{ path: './tree-plugin.js' }] } });
  const options = { registry, codec: 'yaml', baseURI: 'file:///app/trees/mission.yaml',
    readConfig: uri => {
      assert.equal(uri, 'file:///app/config/settings.yaml');
      return { codec: 'yaml', text: encodeConfig({ extensions: [{ path: './file-plugin.js' }] }, { codec: 'yaml' }) };
    },
    config: { extensions: [{ path: './explicit.js' }] }, configBaseURI: 'file:///app/caller/settings.json',
    overrides: { extensions: [{ path: './override.js' }] }, overridesBaseURI: 'file:///app/override/settings.json'
  };
  const result = await resolveTreeConfiguration(text, options);
  assert.deepEqual(result.config.extensions.map(e => e.path), [
    'file:///app/config/file-plugin.js', 'file:///app/trees/tree-plugin.js',
    'file:///app/caller/explicit.js', 'file:///app/override/override.js'
  ]);
  assert.equal(creates, 0);
  await assert.rejects(loadConfiguredTree(text, options), /Enabled extensions require an extension loader/);
  assert.equal(creates, 0);
});

test('disabled extensions permit runner creation and explicit paths default to the tree URI', async () => {
  const registry = createRegistry(), tick = () => SUCCESS;
  registry.registerAction('root', { tick });
  const text = encodeTree(action({ id: 'root', tick }), { registry });
  const loaded = await loadConfiguredTree(text, { registry, baseURI: 'file:///app/tree.json',
    config: { extensions: [{ path: './unused.js', enabled: false }] } });
  assert.equal(loaded.config.extensions[0].path, 'file:///app/unused.js');
  assert.equal(loaded.createRunner().tick().status, SUCCESS);
});
