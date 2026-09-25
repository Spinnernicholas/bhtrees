import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, retry, createRegistry, createRunner, encodeTree, decodeTree,
  toTreeDocument, fromTreeDocument, toPortableValue, DocumentError } from '../dist/index.js';

function setup() {
  const registry = createRegistry();
  let created = 0, entered = 0;
  registry.registerNode('constant', { version: 1, create({ id, reactive, data }) {
    created++;
    return action({ id, reactive, tick: c => { entered++; return c.success(data); } });
  } });
  return { registry, counts: () => ({ created, entered }) };
}
const at = path => error => error instanceof DocumentError && error.path === path;

test('custom factories round trip data and shared definitions without executing actions', () => {
  const { registry, counts } = setup();
  const data = { answer: 42 };
  const child = registry.createNode('constant', { id: 'answer', data, reactive: false });
  data.answer = 0;
  registry.registerNode('pair', { version: 1, create({ id, reactive, children }) {
    return sequence({ id, reactive, steps: children.map(node => ({ node })) });
  } });
  const root = registry.createNode('pair', { id: 'root', reactive: true, data: null, children: [child, child] });
  const text = encodeTree(root, { registry });
  assert.deepEqual(counts(), { created: 1, entered: 0 });
  const loaded = decodeTree(text, { registry });
  assert.equal(loaded.steps[0].node, loaded.steps[1].node);
  assert.equal(loaded.reactive, true);
  assert.equal(loaded.steps[0].node.reactive, false);
  assert.deepEqual(counts(), { created: 2, entered: 0 });
  assert.equal(createRunner(loaded).tick().output.answer, 42);
  assert.equal(createRunner(loaded).tick().output.answer, 42);
  assert.deepEqual(toTreeDocument(loaded, { registry }), JSON.parse(text));
  const document = toTreeDocument(root, { registry });
  document.nodes[1].data.entries[0][1] = 100;
  assert.equal(decodeTree(encodeTree(root, { registry }), { registry }).steps[0].node.tick({ success: x => x }).answer, 42);
  assert.throws(() => encodeTree(root, { registry: createRegistry() }), /different registry/);
});

test('custom structural factories preserve normal runtime semantics', () => {
  const registry = createRegistry();
  let tries = 0;
  const tick = c => ++tries === 3 ? c.success(tries) : c.failure(tries);
  registry.registerAction('attempt', { tick });
  registry.registerNode('attempts', { version: 1, create({ id, reactive, data, children }) {
    return retry({ id, reactive, child: children[0], attempts: data });
  } });
  const root = registry.createNode('attempts', { id: 'retry', data: 3, children: [action({ id: 'attempt', tick })] });
  const runner = createRunner(decodeTree(encodeTree(root, { registry }), { registry }));
  let state;
  for (let i = 0; i < 10; i++) { state = runner.tick(); if (state.status === 'SUCCESS') break; }
  assert.equal(state.status, 'SUCCESS');
  assert.equal(state.output, 3);
});

test('node data migrates sequentially and exports at the current version', () => {
  const registry = createRegistry(), calls = [];
  const factory = { version: 3, migrations: {
    1: data => { calls.push(1); return { value: data }; },
    2: data => { calls.push(2); return { answer: data.value + 1 }; }
  }, create({ id, reactive, data }) { calls.push('create'); return action({ id, reactive, tick: c => c.success(data.answer) }); } };
  registry.registerNode('answer', factory);
  factory.migrations[1] = () => { throw Error('mutated'); };
  const document = { format: 'bhtrees', version: 1, kind: 'tree', root: 'root', nodes: [
    { id: 'root', type: 'custom', implementation: 'answer', implementationVersion: 1, data: 41, children: [] }
  ] };
  const before = structuredClone(document);
  const root = fromTreeDocument(document, { registry });
  assert.deepEqual(calls, [1, 2, 'create']);
  assert.equal(createRunner(root).tick().output, 42);
  assert.deepEqual(document, before);
  const current = toTreeDocument(root, { registry });
  assert.equal(current.nodes[0].implementationVersion, 3);
  assert.deepEqual(calls, [1, 2, 'create']);
  assert.equal(createRunner(fromTreeDocument(current, { registry })).tick().output, 42);
  assert.deepEqual(calls, [1, 2, 'create', 'create']);
});

test('factory data supports custom value codecs', () => {
  const { registry } = setup();
  registry.registerValue('date', { version: 1, test: x => x instanceof Date,
    encode: x => x.toISOString(), decode: x => new Date(x) });
  const root = registry.createNode('constant', { id: 'date', data: { date: new Date('2020-01-01Z') } });
  const loaded = decodeTree(encodeTree(root, { registry }), { registry });
  assert.equal(createRunner(loaded).tick().output.date.toISOString(), '2020-01-01T00:00:00.000Z');
});

test('malformed references and versions fail before factories run', () => {
  const { registry, counts } = setup();
  const root = registry.createNode('constant', { id: 'root', data: null });
  const document = toTreeDocument(root, { registry });
  const cases = [
    [d => d.nodes[0].children.push('root'), '$.nodes[0].children[0]'],
    [d => d.nodes[0].children.push('missing'), '$.nodes[0].children[0]'],
    [d => d.nodes[0].children = null, '$.nodes[0].children'],
    [d => d.nodes[0].implementationVersion = 2, '$.nodes[0].implementationVersion'],
    [d => d.nodes[0].implementation = 'missing', '$.nodes[0].implementation'],
    [d => d.nodes[0].extra = true, '$.nodes[0].extra'],
    [d => d.nodes.push({ ...d.nodes[0], id: 'unreachable' }), '$.nodes']
  ];
  for (const [mutate, path] of cases) {
    const invalid = structuredClone(document); mutate(invalid);
    assert.throws(() => fromTreeDocument(invalid, { registry }), at(path));
  }
  assert.deepEqual(counts(), { created: 1, entered: 0 });
});

test('invalid factories, migrations and payloads carry document paths', () => {
  const { registry } = setup();
  const document = toTreeDocument(registry.createNode('constant', { id: 'root', data: null }), { registry });
  for (const [name, create] of Object.entries({
    wrongId: () => action({ id: 'other', tick: c => c.success() }),
    wrongReactive: ({ id }) => action({ id, reactive: true, tick: c => c.success() }),
    async: async () => null,
    throws: () => { throw new Error('factory failed'); },
    invalid: ({ id, reactive }) => ({ id, reactive, type: 'action', tick: 42 })
  })) {
    registry.registerNode(name, { version: 1, create });
    assert.throws(() => fromTreeDocument({ ...document, nodes: [{ ...document.nodes[0], implementation: name }] }, { registry }), at('$.nodes[0]'));
  }
  registry.registerNode('drops', { version: 1, create: ({ id, reactive }) => sequence({ id, reactive, steps: [] }) });
  const child = registry.createNode('constant', { id: 'child', data: null });
  assert.throws(() => registry.createNode('drops', { id: 'root', data: null, children: [child] }), at('$node.children'));
  registry.registerNode('reorders', { version: 1, create: ({ id, reactive, children }) =>
    sequence({ id, reactive, steps: [...children].reverse().map(node => ({ node })) }) });
  const other = registry.createNode('constant', { id: 'other', data: null });
  assert.throws(() => registry.createNode('reorders', { id: 'root', data: null, children: [child, other] }), at('$node.children'));
  assert.throws(() => registry.createNode('constant', { id: 'root', reactive: null, data: null }), at('$node.reactive'));
  assert.throws(() => registry.createNode('constant', { id: 'root', data: () => {} }), at('$node.data'));
  for (const migrations of [undefined, { 1: () => { throw Error('migration failed'); } }, { 1: async x => x }]) {
    const r = createRegistry();
    r.registerNode('constant', { version: 2, migrations, create: () => { throw Error('must not create'); } });
    assert.throws(() => fromTreeDocument(document, { registry: r }), at(migrations ? '$.nodes[0].data' : '$.nodes[0].implementationVersion'));
  }
  document.nodes[0].data = { kind: 'unknown' };
  assert.throws(() => fromTreeDocument(document, { registry }), at('$.nodes[0].data.kind'));
});

test('custom reference chains enforce the document depth limit before construction', () => {
  const { registry, counts } = setup();
  registry.registerNode('wrapper', { version: 1, create: ({ id, reactive, children }) =>
    sequence({ id, reactive, steps: children.map(node => ({ node })) }) });
  const records = Array.from({ length: 130 }, (_, i) => ({ id: String(i), type: 'custom',
    implementation: i === 129 ? 'constant' : 'wrapper', implementationVersion: 1,
    data: null, children: i === 129 ? [] : [String(i + 1)] }));
  assert.throws(() => fromTreeDocument({ format: 'bhtrees', version: 1, kind: 'tree', root: '0', nodes: records }, { registry }), /depth exceeds/);
  assert.deepEqual(counts(), { created: 0, entered: 0 });
});

test('factory registrations validate names, versions, migrations and collisions', () => {
  const registry = createRegistry();
  const create = ({ id, reactive }) => sequence({ id, reactive, steps: [] });
  for (const factory of [{ version: 0, create }, { version: 1, create: null },
    { version: 2, create, migrations: { 2: x => x } }, { version: 2, create, migrations: { '01': x => x } }]) {
    assert.throws(() => registry.registerNode('bad', factory), TypeError);
  }
  assert.throws(() => registry.registerNode('', { version: 1, create }), TypeError);
  registry.registerNode('node', { version: 1, create });
  assert.throws(() => registry.registerNode('node', { version: 1, create }), /Duplicate/);
  assert.throws(() => registry.registerAction('node', { tick: c => c.success() }), /Duplicate/);
  assert.throws(() => registry.registerCondition('node', () => true), /Duplicate/);
  registry.registerCondition('condition', () => true);
  assert.throws(() => registry.registerNode('condition', { version: 1, create }), /Duplicate/);
  assert.throws(() => registry.createNode('missing', { id: 'root', data: null }), /Unknown/);
  const r = createRegistry();
  r.registerNode('many', { version: 130, create });
  assert.throws(() => fromTreeDocument({ format: 'bhtrees', version: 1, kind: 'tree', root: 'root', nodes: [
    { id: 'root', type: 'custom', implementation: 'many', implementationVersion: 1, data: toPortableValue(null), children: [] }
  ] }, { registry: r }), /Too many migration steps/);
});
