import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlackboard, action, condition, sequence, subtree, parallel, createRunner,
  SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

test('blackboards distinguish absent/undefined values and emit immutable ordered changes', () => {
  const board = createBlackboard({ count: 1 }), events = [];
  assert.ok(Object.isFrozen(board));
  board.subscribe(event => events.push(event));
  board.set('missing', undefined);
  board.set('count', 2);
  assert.equal(board.delete('missing'), true);
  assert.equal(board.delete('missing'), false);
  assert.equal(board.has('missing'), false);
  assert.equal(board.get('count'), 2);
  assert.deepEqual(events, [
    { revision: 1, type: 'set', key: 'missing', hadValue: false, previous: undefined, value: undefined },
    { revision: 2, type: 'set', key: 'count', hadValue: true, previous: 1, value: 2 },
    { revision: 3, type: 'delete', key: 'missing', hadValue: true, previous: undefined, value: undefined }
  ]);
  assert.ok(events.every(Object.isFrozen)); assert.equal(board.revision, 3);
});

test('snapshots preserve top-level historical values and own special keys safely', () => {
  const initial = JSON.parse('{"__proto__":1,"constructor":2}');
  const board = createBlackboard(initial);
  initial.constructor = 3;
  const first = board.snapshot();
  assert.equal(Object.getPrototypeOf(first.values), null);
  assert.equal(first.values.__proto__, 1); assert.equal(first.values.constructor, 2);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.values));
  assert.equal(board.snapshot(), first);
  board.set('__proto__', 4);
  assert.equal(first.values.__proto__, 1);
  assert.equal(board.snapshot().values.__proto__, 4);
  assert.notEqual(board.snapshot(), first);
});

test('unchanged Object.is values do not notify and nested mutations are not observed', () => {
  const value = { nested: 1 }, board = createBlackboard({ value, nan: NaN, zero: 0 });
  const events = []; board.subscribe(event => events.push(event));
  board.set('value', value); board.set('nan', NaN); board.set('zero', 0);
  value.nested = 2;
  assert.equal(events.length, 0); assert.equal(board.snapshot().values.value.nested, 2);
  board.set('zero', -0); assert.equal(events.length, 1);
});

test('subscriptions are independently disposable and do not emit an initial event', () => {
  const board = createBlackboard(), revisions = [];
  const listener = event => revisions.push(event.revision);
  const a = board.subscribe(listener), b = board.subscribe(listener);
  assert.deepEqual(revisions, []);
  board.set('x', 1); a(); a(); board.set('x', 2); b(); board.set('x', 3);
  assert.deepEqual(revisions, [1, 1, 2]);
});

test('reentrant writes notify every observer in revision order', () => {
  const board = createBlackboard(), a = [], b = [];
  board.subscribe(event => { a.push(event.revision); if (event.key === 'first') board.set('second', 2); });
  board.subscribe(event => b.push(event.revision));
  board.set('first', 1);
  assert.deepEqual(a, [1, 2]); assert.deepEqual(b, [1, 2]);
  assert.equal(board.revision, 2);
});

test('observer errors do not roll back writes or skip other observers and notification recovers', () => {
  const board = createBlackboard(), revisions = [];
  const error = new Error('observer');
  const unsubscribe = board.subscribe(() => { throw error; });
  board.subscribe(event => revisions.push(event.revision));
  assert.throws(() => board.set('x', 1), cause => cause instanceof AggregateError && cause.errors[0] === error);
  assert.equal(board.get('x'), 1); assert.deepEqual(revisions, [1]);
  unsubscribe(); board.set('x', 2); assert.deepEqual(revisions, [1, 2]);
});

test('runners omit blackboards by default and preserve ordinary data flow', () => {
  const runner = createRunner(action({ id: 'plain', tick(c) {
    assert.equal(c.blackboard, undefined); return c.success(c.input);
  } }), { input: 42 });
  assert.equal(runner.tick().output, 42); assert.equal(runner.snapshot().blackboard, undefined);
});

test('caller controls board sharing and runner cancellation does not dispose board subscribers', () => {
  const board = createBlackboard({ count: 0 }), separate = createBlackboard({ count: 0 });
  const revisions = []; board.subscribe(event => revisions.push(event.revision));
  const tree = action({ id: 'increment', tick(c) { c.blackboard.set('count', c.blackboard.get('count') + 1); return RUNNING; } });
  const a = createRunner(tree, { blackboard: board }), b = createRunner(tree, { blackboard: board });
  const c = createRunner(tree, { blackboard: separate });
  a.tick(); b.tick(); c.tick();
  assert.equal(board.get('count'), 2); assert.equal(separate.get('count'), 1);
  const old = a.snapshot(); a.cancel(); board.set('count', 3);
  assert.equal(old.blackboard.values.count, 2);
  assert.equal(a.snapshot().blackboard.values.count, 3);
  assert.deepEqual(revisions, [1, 2, 3]);
});

test('reactive conditions see external writes and interrupt work', () => {
  const blackboard = createBlackboard({ allowed: true }); let cancelled = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: condition({ id: 'guard', test: c => c.blackboard.get('allowed') }) },
    { node: action({ id: 'work', tick: () => RUNNING, cancel: () => { cancelled++; } }) }
  ] }), { blackboard });
  runner.tick(); runner.pause(); blackboard.set('allowed', false);
  assert.equal(runner.tick().status, RUNNING); assert.equal(cancelled, 0);
  runner.continue(); assert.equal(runner.tick().status, FAILURE); assert.equal(cancelled, 1);
});

test('parallel and subtree actions share only the explicitly injected board', () => {
  const blackboard = createBlackboard();
  const writer = subtree({ id: 'call', child: action({ id: 'write', tick(c) { c.blackboard.set('value', 42); return SUCCESS; } }) });
  const tree = parallel({ id: 'parallel', successThreshold: 2, failureThreshold: 1, steps: [
    { node: writer }, { node: condition({ id: 'read', test: c => c.blackboard.get('value') === 42 }) }
  ] });
  assert.equal(createRunner(tree, { blackboard }).tick().status, SUCCESS);
});

test('observer-triggered runner reentry remains an execution error with a committed write', () => {
  const blackboard = createBlackboard();
  const runner = createRunner(action({ id: 'write', tick(c) { c.blackboard.set('value', 1); return SUCCESS; } }), { blackboard });
  blackboard.subscribe(() => runner.tick());
  assert.equal(runner.tick().status, 'errored');
  assert.match(runner.snapshot().error.errors[0].message, /not reentrant/);
  assert.equal(blackboard.get('value'), 1);
});

test('blackboard validates keys, records, listeners, and runner injection', () => {
  for (const initial of [null, [], 1, 'text', new Map(), new Date()]) assert.throws(() => createBlackboard(initial), /plain record/);
  const board = createBlackboard();
  for (const key of [null, 1, Symbol('x'), {}]) {
    for (const method of ['get', 'has', 'set', 'delete']) assert.throws(() => board[method](key), /strings/);
  }
  assert.throws(() => board.subscribe(null), /subscriber/);
  for (const blackboard of [null, {}, false]) assert.throws(() => createRunner(action({ id: 'x', tick: () => SUCCESS }), { blackboard }), /Invalid blackboard/);
});
