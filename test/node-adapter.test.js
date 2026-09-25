import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadNodeTree, createNodeExtensionLoader, readNodeConfig, toFileURI } from 'bhtrees/node';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bhtrees-node-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  async function put(name, text) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
    return path;
  }
  return { dir, put };
}
const plugin = (id = 'plugin') => `export default {
  id: ${JSON.stringify(id)}, version: '1', apiVersion: 1,
  setup(api) { api.registerAction('run', { tick: c => c.success(42) }); }
};`;
const tree = config => JSON.stringify({ format: 'bhtrees', version: 1, kind: 'tree', root: 'a',
  nodes: [{ id: 'a', type: 'action', implementation: 'run', implementationVersion: 1 }], ...config });

test('file adapter resolves extensions relative to separate YAML config and disposes runners', async t => {
  const { put } = await fixture(t);
  await put('config/plugin with spaces.mjs', plugin());
  await put('config/settings.yml', 'format: bhtrees\nversion: 1\nkind: config\nconfig:\n  extensions:\n    - path: "./plugin with spaces.mjs"\n');
  const path = await put('trees/mission.json', tree({ configFile: '../config/settings.yml' }));
  const loaded = await loadNodeTree(path);
  assert.equal(loaded.createRunner().tick().output, 42);
  assert.match(loaded.extensionSnapshot()[0].location, /config\/plugin%20with%20spaces.mjs$/);
  const pending = loaded.createRunner();
  await loaded.dispose();
  assert.equal(pending.snapshot().status, 'cancelled');
  assert.equal(loaded.extensionSnapshot()[0].status, 'disposed');
});

test('installed packages resolve from the host tree with mappings and lazy disabled declarations', async t => {
  const { put } = await fixture(t);
  await put('node_modules/example-extension/package.json', JSON.stringify({ name: 'example-extension', type: 'module', exports: './main.js' }));
  await put('node_modules/example-extension/main.js', plugin());
  const path = await put('mission.json', tree({ config: { extensions: [
    { name: 'plugin' }, { name: 'not-installed', enabled: false }
  ] } }));
  const loaded = await loadNodeTree(path, { extensions: { packages: { plugin: 'example-extension' } } });
  assert.equal(loaded.createRunner().tick().output, 42);
  await loaded.dispose();
  await assert.rejects(loadNodeTree(path), /Cannot find module/);
});

test('module policy denies imports before evaluation and built-ins take precedence', async t => {
  const { put } = await fixture(t);
  const path = await put('throw.mjs', 'throw Error("module evaluated");');
  const loader = createNodeExtensionLoader({ baseURI: path, allowModule: () => false,
    builtins: { builtin: { id: 'builtin', version: '1', apiVersion: 1, setup() {} } } });
  await assert.rejects(loader.load([{ path: toFileURI(path) }]), /denied by host policy/);
  const session = await loader.load([{ name: 'builtin' }]);
  assert.equal(session.snapshot()[0].location, 'builtin:builtin');
  await session.dispose();
  await assert.rejects(loader.load([{ name: 'fs' }]), /installed package/);
});

test('installed dependencies load before dependents and import-only packages allow a catalog override', async t => {
  const { put } = await fixture(t);
  await put('node_modules/base/package.json', JSON.stringify({ type: 'module', exports: './main.js' }));
  await put('node_modules/base/main.js', `export default { id: 'base', version: '1', apiVersion: 1,
    setup(api) { api.registerService('answer', 42); } };`);
  await put('node_modules/plugin/package.json', JSON.stringify({ type: 'module', exports: { import: './main.js' } }));
  const modulePath = await put('node_modules/plugin/main.js', `export default { id: 'plugin', version: '1', apiVersion: 1,
    dependencies: ['base'], setup(api) { api.registerAction('run', { tick: c => c.success(api.getService('answer')) }); } };`);
  const path = await put('mission.json', tree({ config: { extensions: [{ name: 'plugin' }] } }));
  await assert.rejects(loadNodeTree(path), /exports/);
  const loaded = await loadNodeTree(path, { extensions: { catalog: { plugin: toFileURI(modulePath) } } });
  assert.deepEqual(loaded.extensionSnapshot().map(s => s.id), ['base', 'plugin']);
  assert.equal(loaded.createRunner().tick().output, 42);
  await loaded.dispose();
});

test('file conversion and codec errors are explicit; native import failures retain context', async t => {
  const { put } = await fixture(t);
  const path = await put('file # one.json', '{}');
  const uri = toFileURI(path);
  assert.equal(uri, pathToFileURL(path).href);
  assert.equal(toFileURI(new URL(uri)), uri);
  assert.equal((await readNodeConfig(uri)).codec, 'json');
  assert.throws(() => toFileURI('https://example.test/a.json'), /filesystem path/);
  assert.throws(() => toFileURI(`${uri}#fragment`), /query or fragment/);
  await assert.rejects(readNodeConfig(toFileURI(await put('unknown.txt', '{}'))), /infer document codec/);
  const broken = await put('bad.mjs', 'throw Error("evaluation failed");');
  const loader = createNodeExtensionLoader({ baseURI: path });
  await assert.rejects(loader.load([{ path: toFileURI(broken) }]), /resolution failed.*evaluation failed/);
});
