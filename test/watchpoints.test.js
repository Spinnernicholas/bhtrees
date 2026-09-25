import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, createRunner, createDebugger, createBlackboard, RUNNING } from '../dist/index.js';

test('writes pause after the current handler and before a sibling side effect', () => {
  const board = createBlackboard({ hp: 10 }), calls = [];
  const debug = createDebugger(createRunner(sequence({ id: 'root', steps: [
    { node: action({ id: 'write', tick(c) { c.blackboard.set('hp', 5); calls.push('handler finished'); return c.success(); } }) },
    { node: action({ id: 'sibling', tick(c) { calls.push('sibling'); return c.success(); } }) }
  ] }), { blackboard: board }));
  debug.command({ type: 'setWatchpoint', key: 'hp' }); debug.command({ type: 'tick' });
  assert.deepEqual(calls, ['handler finished']); assert.equal(debug.snapshot().runner.paused, true);
  assert.equal(debug.snapshot().watchpointHit.previous, 10); assert.equal(debug.snapshot().watchpointHit.value, 5);
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  assert.deepEqual(calls, ['handler finished', 'sibling']); assert.equal(debug.snapshot().watchpointHit, null);
});

test('delete filters, identical sets, nested mutation and external writes follow board semantics', () => {
  const nested = { x: 1 }, board = createBlackboard({ key: nested });
  const debug = createDebugger(createRunner(action({ id: 'a', tick: () => RUNNING }), { blackboard: board }));
  debug.command({ type: 'setWatchpoint', key: 'key', operation: 'delete' });
  board.set('key', nested); nested.x = 2; board.set('other', 1); debug.refresh();
  assert.equal(debug.snapshot().watchpointHit, null);
  board.delete('key'); debug.refresh();
  assert.equal(debug.snapshot().runner.paused, true); assert.equal(debug.snapshot().watchpointHit.type, 'delete');
  assert.equal(debug.snapshot().watchpointHit.hadValue, true);
});

test('advanced stepping stops on a watchpoint and multiple writes retain the latest hit', () => {
  const board = createBlackboard();
  const debug = createDebugger(createRunner(action({ id: 'a', tick(c) {
    c.blackboard.set('k', 1); c.blackboard.set('k', 2); return RUNNING;
  } }), { blackboard: board }));
  debug.command({ type: 'setWatchpoint', key: 'k', operation: 'set' });
  debug.command({ type: 'stepInto' }); debug.command({ type: 'stepOver' });
  assert.equal(debug.snapshot().stepResult.reason, 'watchpoint');
  assert.equal(debug.snapshot().watchpointHit.value, 2); assert.equal(debug.snapshot().watchpointHit.revision, 2);
});

test('removal and debugger disposal detach observers without disposing caller board', () => {
  const board = createBlackboard(), source = createRunner(action({ id: 'a', tick: () => RUNNING }), { blackboard: board });
  const debug = createDebugger(source);
  debug.command({ type: 'setWatchpoint', key: 'k' }); debug.command({ type: 'removeWatchpoint', key: 'k' });
  board.set('k', 1); assert.equal(source.snapshot().paused, false);
  debug.command({ type: 'setWatchpoint', key: 'k' }); debug.dispose();
  board.set('k', 2); assert.equal(source.snapshot().paused, false); assert.equal(board.get('k'), 2);
});

test('missing boards and malformed requests fail without changing state; observer errors are isolated', () => {
  const debug = createDebugger(createRunner(action({ id: 'a', tick: () => RUNNING })));
  assert.equal(debug.command({ type: 'setWatchpoint', key: 'k' }).code, 'INVALID_STATE');
  for (const command of [{ type: 'setWatchpoint', key: 2 }, { type: 'setWatchpoint', key: 'k', operation: null }]) {
    assert.equal(debug.command(command).code, 'INVALID_COMMAND');
  }
  const board = createBlackboard(), errors = [];
  const runner = createRunner(action({ id: 'a', tick: () => RUNNING }), { blackboard: board, onEventError: e => errors.push(e) });
  const off = runner.observeBlackboard(() => { throw Error('observer'); });
  board.set('k', 1); assert.equal(errors.length, 1); off(); board.set('k', 2); assert.equal(errors.length, 1);
});
