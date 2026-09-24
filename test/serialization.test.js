import test from 'node:test';
import assert from 'node:assert/strict';
import { action, condition, sequence, selector, parallel, subtree, inverter, forceSuccess, forceFailure,
  retry, repeat, delay, timeout, cooldown, createRegistry, toTreeDocument, fromTreeDocument,
  encodeTree, decodeTree, DocumentError, createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

const tick = c => c.success(c.input);
function registry() { const r = createRegistry(); r.registerAction('echo', { tick }); return r; }
const echo = () => action({ id: 'echo', tick });

test('JSON tree round trip preserves shared definitions and declarative data flow', () => {
  const r = registry(), shared = echo();
  const root = sequence({ id: 'root', steps: [
    { node: subtree({ id: 'first', child: shared, input: { path: ['input', 'a'] } }), save: 'first' },
    { node: subtree({ id: 'second', child: shared, input: { path: ['input', 'b'] } }), save: 'second' }
  ], output: { path: ['vars'] } });
  const document = toTreeDocument(root, { registry: r });
  assert.equal(document.format, 'bhtrees'); assert.equal(document.version, 1); assert.equal(document.kind, 'tree');
  assert.equal(document.nodes.filter(node => node.id === 'echo').length, 1);
  const loaded = decodeTree(encodeTree(root, { registry: r }), { registry: r });
  assert.equal(loaded.steps[0].node.child, loaded.steps[1].node.child);
  const state = createRunner(loaded, { input: { a: 2, b: 3 } }).tick();
  assert.equal(state.status, SUCCESS); assert.deepEqual({ ...state.output }, { first: 2, second: 3 });
  assert.deepEqual(toTreeDocument(loaded, { registry: r }), document);
});

test('all built-in structural nodes and infinite counts round trip', () => {
  const r = registry(), shared = echo();
  const branches = [
    selector({ id: 'selector', reactive: true, steps: [{ node: shared }] }),
    inverter({ id: 'inverter', child: shared }), forceSuccess({ id: 'success', child: shared }),
    forceFailure({ id: 'failure', child: shared }), retry({ id: 'retry', child: shared, attempts: Infinity }),
    repeat({ id: 'repeat', child: shared, times: Infinity }), delay({ id: 'delay', child: shared, ms: 5 }),
    timeout({ id: 'timeout', child: shared, ms: 10 }), cooldown({ id: 'cooldown', child: shared, ms: 20 })
  ];
  const root = parallel({ id: 'parallel', steps: branches.map(node => ({ node })), successThreshold: branches.length, failureThreshold: 1 });
  const text = encodeTree(root, { registry: r }); assert.match(text, /unbounded/);
  const loaded = decodeTree(text, { registry: r });
  assert.equal(loaded.steps[4].node.attempts, Infinity); assert.equal(loaded.steps[5].node.times, Infinity);
  assert.deepEqual(toTreeDocument(loaded, { registry: r }), toTreeDocument(root, { registry: r }));
});

test('registered conditions and async action continuations stay in code', () => {
  const r = createRegistry(); let token, entered = 0, cancelled = 0;
  const testReady = c => c.services.ready;
  const implementation = { enter(c) { entered++; token = c.wait.callback({ resume: 'done' }); return token.wait; },
    resume: { done: (c, value) => c.success(value) }, cancel: () => { cancelled++; } };
  r.registerCondition('ready', testReady, 2); r.registerAction('wait', implementation, 3);
  const root = sequence({ id: 'root', steps: [
    { node: condition({ id: 'guard', test: testReady }) }, { node: action({ id: 'waiter', ...implementation }) }
  ] });
  const text = encodeTree(root, { registry: r });
  assert.doesNotMatch(text, /entered|function|=>/);
  const loaded = decodeTree(text, { registry: r }); assert.equal(entered, 0);
  const runner = createRunner(loaded, { services: { ready: true } }); runner.tick(); token.resolve(42);
  assert.equal(runner.tick().output, 42);
  const second = createRunner(loaded, { services: { ready: true } }); second.tick(); second.cancel();
  assert.equal(cancelled, 1);
});

test('strict export rejects inline code and identifies its field path', () => {
  assert.throws(() => encodeTree(echo()), error => error instanceof DocumentError && error.path === '$.nodes[0].implementation');
  const r = registry();
  for (const root of [sequence({ id: 'root', steps: [{ node: echo() }], output: s => s.last }),
    sequence({ id: 'root', steps: [{ node: echo(), input: s => s.input }] })]) {
    assert.throws(() => encodeTree(root, { registry: r }), error => error instanceof DocumentError && /output|input/.test(error.path) && /Function bindings/.test(error.message));
  }
});

test('decode validates envelopes, versions, fields, bindings, and reference graphs', () => {
  const r = registry();
  const valid = toTreeDocument(sequence({ id: 'root', steps: [{ node: echo() }] }), { registry: r });
  const cases = [
    [d => d.version = 2, '$.version'], [d => d.format = 'other', '$.format'], [d => d.kind = 'checkpoint', '$.kind'],
    [d => d.extra = true, '$.extra'], [d => d.root = 'missing', '$.root'],
    [d => d.nodes.push(d.nodes[1]), '$.nodes[2].id'],
    [d => d.nodes[0].steps[0].node = 'missing', '$.nodes[0].steps[0].node'],
    [d => d.nodes[0].steps[0].node = 'root', '$.nodes[0].steps[0].node'],
    [d => d.nodes[0].output = { path: 'input' }, '$.nodes[0].output'],
    [d => d.nodes[1].implementationVersion = 99, '$.nodes[1].implementationVersion'],
    [d => d.nodes[1].implementation = 'missing', '$.nodes[1].implementation'],
    [d => d.nodes[0].steps = [], '$.nodes']
  ];
  for (const [mutate, path] of cases) {
    const document = structuredClone(valid); mutate(document);
    assert.throws(() => fromTreeDocument(document, { registry: r }), error => error instanceof DocumentError && error.path === path);
  }
  assert.throws(() => decodeTree('{'), /Invalid JSON/);
});

test('registry names are unique, versioned, and scoped to the registry instance', () => {
  const r = registry();
  assert.throws(() => r.registerAction('echo', { tick }), /Duplicate/);
  assert.throws(() => r.registerCondition('echo', () => true), /Duplicate/);
  assert.throws(() => r.registerAction('bad', { tick }, 0), /versions/);
  const text = encodeTree(echo(), { registry: r });
  assert.throws(() => decodeTree(text, { registry: createRegistry() }), /Unknown action/);
  const wrong = createRegistry(); wrong.registerAction('echo', { tick }, 2);
  assert.throws(() => decodeTree(text, { registry: wrong }), /implementationVersion/);
});

test('documents reject invalid numeric options instead of silently losing values', () => {
  const r = registry();
  const document = toTreeDocument(retry({ id: 'retry', child: echo(), attempts: 3 }), { registry: r });
  for (const value of [NaN, Infinity, -1, 0, '3', undefined]) {
    document.nodes[0].attempts = value;
    assert.throws(() => fromTreeDocument(document, { registry: r }), /attempts/);
  }
});

test('document APIs reject accessors and export rejects cyclic or conflicting definitions', () => {
  let called = false;
  assert.throws(() => fromTreeDocument({ get format() { called = true; return 'bhtrees'; } }), /data properties/);
  assert.equal(called, false);
  const cycle = { id: 'cycle', type: 'subtree', reactive: false, output: { path: ['last'] } }; cycle.child = cycle;
  assert.throws(() => toTreeDocument(cycle), /Cyclic/);
  const r = registry();
  assert.throws(() => encodeTree(sequence({ id: 'root', steps: [{ node: echo() }, { node: echo() }] }), { registry: r }), /Duplicate node ID/);
});

test('document size and reference depth limits are enforced', () => {
  assert.throws(() => decodeTree(' '.repeat(1000001)), /1000000/);
  const r = registry();
  let root = echo();
  for (let i = 0; i < 130; i++) root = subtree({ id: `call-${i}`, child: root });
  assert.throws(() => toTreeDocument(root, { registry: r }), /depth/);
  const document = { format: 'bhtrees', version: 1, kind: 'tree', root: 'call-129', nodes: [
    { id: 'echo', type: 'action', implementation: 'echo', implementationVersion: 1 },
    ...Array.from({ length: 130 }, (_, i) => ({ id: `call-${i}`, type: 'subtree', child: i ? `call-${i - 1}` : 'echo' }))
  ] };
  assert.throws(() => fromTreeDocument(document, { registry: r }), /depth/);
});
