import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserTree, readBrowserConfig, createBrowserExtensionLoader } from 'bhtrees/browser';

const tree = extra => JSON.stringify({ format: 'bhtrees', version: 1, kind: 'tree', root: 'a',
  nodes: [{ id: 'a', type: 'action', implementation: 'run', implementationVersion: 1 }], ...extra });
const manifest = (extra = {}) => ({ id: 'plugin', version: '1', apiVersion: 1,
  setup(api) { api.registerAction('run', { tick: c => c.success(42) }); }, ...extra });
function fetchFiles(files, calls = []) {
  return async (uri, options) => {
    calls.push([uri, options]);
    return new Response(files[uri] ?? 'missing', { status: Object.hasOwn(files, uri) ? 200 : 404 });
  };
}

test('browser tree fetches relative YAML config and imports extensions from its declaring URL', async () => {
  const calls = [], imports = [];
  const loaded = await loadBrowserTree('../trees/tree.json?version=1', {
    baseURI: 'https://host.test/app/index.html',
    fetch: fetchFiles({
      'https://host.test/trees/tree.json?version=1': tree({ configFile: '../settings/config.yaml' }),
      'https://host.test/settings/config.yaml': 'format: bhtrees\nversion: 1\nkind: config\nconfig:\n  extensions:\n    - path: ./plugin.js\n'
    }, calls),
    extensions: { importModule: uri => { imports.push(uri); return { default: manifest() }; } }
  });
  assert.deepEqual(imports, ['https://host.test/settings/plugin.js']);
  assert.equal(loaded.createRunner().tick().output, 42);
  assert.equal(calls.length, 2); assert.ok(calls.every(([, options]) => options.redirect === 'error'));
  await loaded.dispose(); assert.equal(loaded.extensionSnapshot()[0].status, 'disposed');
});

test('catalog and named dependencies resolve relative to explicit base, preserving built-in priority', async () => {
  const imports = [], resolutions = [];
  const loader = createBrowserExtensionLoader({ baseURI: 'https://host.test/modules/catalog.json',
    builtins: { base: { id: 'base', version: '1', apiVersion: 1, setup() {} } },
    catalog: { plugin: './plugin.js' },
    resolveName(name) { resolutions.push(name); return '/extras/helper.js'; },
    importModule(uri) { imports.push(uri); return uri.endsWith('/plugin.js') ? manifest({ dependencies: ['base', 'helper'] }) :
      { id: 'helper', version: '1', apiVersion: 1, setup() {} }; }
  });
  const session = await loader.load([{ name: 'plugin' }]);
  assert.deepEqual(imports, ['https://host.test/modules/plugin.js', 'https://host.test/extras/helper.js']);
  assert.deepEqual(resolutions, ['helper']);
  assert.deepEqual(session.snapshot().map(s => s.id), ['base', 'helper', 'plugin']);
  await session.dispose();
});

test('document and module policies prevent host access and unsupported schemes fail', async () => {
  let requests = 0;
  await assert.rejects(readBrowserConfig('https://host.test/a.json', {
    allowDocument: () => false, fetch: async () => { requests++; return new Response('{}'); }
  }), /denied/);
  assert.equal(requests, 0);
  for (const uri of ['file:///a.json', 'data:text/plain,{}', 'https://user:pass@host.test/a.json', 'https://host.test/a.json#x']) {
    await assert.rejects(readBrowserConfig(uri), /HTTP|credentials or fragments/);
  }
  const loader = createBrowserExtensionLoader({ allowModule: () => false, importModule: () => assert.fail('must not import') });
  await assert.rejects(loader.load([{ path: 'https://host.test/plugin.js' }]), /denied/);
  await assert.rejects(loader.load([{ path: 'file:///plugin.js' }]), /HTTP/);
});

test('HTTP, codec and redirect failures are explicit and extension setup is rolled back on abort', async () => {
  await assert.rejects(readBrowserConfig('https://host.test/a.json', { fetch: fetchFiles({}) }), /404/);
  await assert.rejects(readBrowserConfig('https://host.test/a.txt', { fetch: () => assert.fail('no fetch') }), /infer document codec/);
  await assert.rejects(readBrowserConfig('https://host.test/a.json', {
    fetch: async () => ({ ok: true, redirected: true, url: 'https://host.test/other.json' })
  }), /redirects/);
  const controller = new AbortController(), reason = new Error('stop'); let disposed = 0;
  await assert.rejects(loadBrowserTree('https://host.test/tree.custom', {
    codec: 'json', signal: controller.signal,
    fetch: fetchFiles({ 'https://host.test/tree.custom': tree({ config: { extensions: [{ name: 'plugin' }] } }) }),
    extensions: { catalog: { plugin: manifest({ setup(api) {
      api.registerAction('run', { tick: c => c.success() });
      api.onDispose(() => disposed++); controller.abort(reason);
    } }) } }
  }), error => error === reason);
  assert.equal(disposed, 1);
  await assert.rejects(loadBrowserTree('https://host.test/tree.json', {
    signal: controller.signal, fetch: () => assert.fail('aborted fetch')
  }), error => error === reason);
});
