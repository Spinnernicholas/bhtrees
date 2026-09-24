import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, selector, subtree, parallel, createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

const echo = id => action({ id, tick: c => c.success(c.input) });

test('JSON-shaped path bindings pass data between siblings and map composite output', () => {
  const binding = JSON.parse('{"path":["vars","target","positions",0]}');
  const tree = sequence({ id: 'root', steps: [
    { node: echo('read'), save: 'target' },
    { node: echo('move'), input: binding, save: 'position' }
  ], output: { path: ['vars', 'position', 'x'] } });
  assert.equal(createRunner(tree, { input: { positions: [{ x: 42 }] } }).tick().output, 42);
});

test('selector and subtree output paths preserve failure semantics', () => {
  const failed = subtree({ id: 'call', input: { path: ['input', 'reason'] },
    child: action({ id: 'failed', tick: c => c.failure(c.input) }), output: { path: ['result', 'output'] } });
  assert.equal(createRunner(failed, { input: { reason: 'missing' } }).tick().status, FAILURE);
  const fallback = selector({ id: 'choice', steps: [
    { node: failed }, { node: echo('fallback'), input: { path: ['last'] } }
  ], output: { path: ['last'] } });
  assert.equal(createRunner(fallback, { input: { reason: 'missing' } }).tick().output, 'missing');
});

test('parallel paths expose ordered results and preserve isolated branch input scopes', () => {
  const runner = createRunner(parallel({ id: 'parallel', successThreshold: 2, failureThreshold: 1,
    steps: [{ node: echo('a'), input: { path: ['input', 'a'] } }, { node: echo('b'), input: { path: ['vars', 'a'] } }],
    output: { path: ['results', 0, 'output'] }
  }), { input: { a: 7 } });
  assert.equal(runner.tick().output, 7);
});

test('definition construction copies and freezes declarative paths', () => {
  const input = { path: ['input', 'a'] }, output = { path: ['last'] };
  const tree = sequence({ id: 'root', steps: [{ node: echo('a'), input }], output });
  input.path[1] = 'b'; output.path[0] = 'input';
  assert.ok(Object.isFrozen(tree.steps[0].input) && Object.isFrozen(tree.steps[0].input.path));
  assert.ok(Object.isFrozen(tree.output) && Object.isFrozen(tree.output.path));
  assert.equal(createRunner(tree, { input: { a: 1, b: 2 } }).tick().output, 1);
});

test('missing/null/primitive intermediates yield undefined and empty paths return the scope', () => {
  for (const input of [undefined, null, 42, { nested: null }, {}]) {
    const runner = createRunner(subtree({ id: 'call', child: echo('leaf'), input: { path: ['input', 'nested', 'x'] } }), { input });
    assert.equal(runner.tick().output, undefined); assert.equal(runner.snapshot().status, SUCCESS);
  }
  const whole = createRunner(sequence({ id: 'empty', steps: [], output: { path: [] } }), { input: 42 }).tick().output;
  assert.equal(whole.input, 42); assert.equal(whole.last, undefined);
});

test('paths are literal own-property lookups, never expressions or prototype traversal', () => {
  const input = Object.create({ inherited: 'hidden' });
  input['a.b'] = 42;
  Object.defineProperty(input, '__proto__', { value: 'own-data' });
  for (const [key, expected] of [['inherited', undefined], ['a.b', 42], ['__proto__', 'own-data'], ['constructor', undefined], ['a.b()', undefined]]) {
    const runner = createRunner(subtree({ id: 'call', child: echo('leaf'), input: { path: ['input', key] } }), { input });
    assert.equal(runner.tick().output, expected);
  }
});

test('accessors are rejected without invoking them and invalid bindings fail at construction', () => {
  let reads = 0;
  const input = { get value() { reads++; return 42; } };
  const runner = createRunner(subtree({ id: 'call', child: echo('leaf'), input: { path: ['input', 'value'] } }), { input });
  assert.equal(runner.tick().status, 'errored'); assert.match(runner.snapshot().error.message, /accessor/); assert.equal(reads, 0);
  for (const binding of [{}, { path: 'input.x' }, { path: [-1] }, { path: [1.5] }, { path: [null] }, { path: [Infinity] }, { path: [], extra: true }, { get path() { reads++; return []; } }]) {
    assert.throws(() => subtree({ id: 'call', child: echo('leaf'), input: binding }), /binding/);
    assert.throws(() => sequence({ id: 'root', steps: [], output: binding }), /binding/);
  }
  assert.equal(reads, 0);
});

test('reactive retained inputs stay fixed while fresh activations resolve paths again', () => {
  let value = 1, blocked = false;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', tick: () => blocked ? RUNNING : SUCCESS }) },
    { node: action({ id: 'read', tick: c => c.success({ value }) }), save: 'source' },
    { node: echoRunning(), input: { path: ['vars', 'source', 'value'] } }
  ] }));
  function echoRunning() { return action({ id: 'work', tick: () => RUNNING }); }
  runner.tick(); value = 2; runner.tick(); assert.equal(runner.snapshot().frames.at(-1).input, 1);
  blocked = true; runner.tick(); blocked = false; runner.tick();
  assert.equal(runner.snapshot().frames.at(-1).input, 2);
});
