import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import * as core from '../dist/index.js';
import * as browser from '../dist/browser.js';
import * as game from '../dist/adventure-land.js';

const source = await readFile(new URL('../dist/bhtrees.global.js', import.meta.url), 'utf8');
const script = new Script(source, { filename: 'bhtrees.global.js' });
function load() {
  const context = createContext({ setTimeout, clearTimeout, URL });
  script.runInContext(context);
  return context;
}

test('standalone classic script exposes complete public API without module runtime globals', () => {
  const context = load();
  assert.deepEqual(Object.keys(context.BHTrees).sort(), Object.keys({ ...core, ...browser, ...game }).sort());
  assert.equal(Object.isFrozen(context.BHTrees), true);
  assert.deepEqual(Object.getOwnPropertyNames(context).sort(), ['BHTrees', 'URL', 'clearTimeout', 'setTimeout']);
  assert.equal(context.BHTrees.loadNodeTree, undefined);
  assert.equal(new Script(`BHTrees.createRunner(BHTrees.action({ id: 'a', tick: c => c.success(42) })).tick().output`).runInContext(context), 42);
});

test('standalone codecs and extension registry work in an isolated realm', async () => {
  const context = load();
  const value = await new Script(`(async () => {
    const loader = BHTrees.createExtensionLoader({ builtins: { demo: {
      id: 'demo', version: '1', apiVersion: 1,
      setup(api) { api.registerAction('echo', { tick: c => c.success(c.input) }); }
    } } });
    const session = await loader.load([{ name: 'demo' }]);
    const document = { format: 'bhtrees', version: 1, kind: 'tree', root: 'a',
      nodes: [{ id: 'a', type: 'action', implementation: 'echo', implementationVersion: 1 }] };
    const outputs = [];
    for (const codec of ['json', 'yaml']) {
      const text = codec === 'json' ? JSON.stringify(document) : BHTrees.stringifyYaml(document);
      const tree = BHTrees.decodeTree(text, { codec, registry: session.registry });
      outputs.push(BHTrees.createRunner(tree, { input: codec }).tick().output);
    }
    await session.dispose();
    return outputs.join(',');
  })()`).runInContext(context);
  assert.equal(value, 'json,yaml');
});

test('standalone timer waits execute without an external loader', async () => {
  const context = load();
  const result = await new Script(`new Promise((resolve, reject) => {
    const runner = BHTrees.createRunner(BHTrees.action({ id: 'timer',
      enter: c => c.wait.timer(1, { resume: 'done' }), resume: { done: c => c.success(42) }
    }));
    const scheduler = BHTrees.createRunnerScheduler(runner, { intervalMs: 1,
      onTick(state) { if (state.status === 'SUCCESS') { scheduler.dispose(); resolve(state.output); } },
      onError: reject
    });
    scheduler.start();
  })`).runInContext(context);
  assert.equal(result, 42);
});

test('reloading or colliding with a host global fails without replacing it', () => {
  const context = load(), original = context.BHTrees;
  assert.throws(() => script.runInContext(context), /already defined/);
  assert.equal(context.BHTrees, original);
  const host = createContext({ BHTrees: 'owned by host' });
  assert.throws(() => script.runInContext(host), /already defined/);
  assert.equal(host.BHTrees, 'owned by host');
});
