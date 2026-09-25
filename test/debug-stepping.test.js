import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, repeat, parallel, createRunner, createDebugger, RUNNING } from '../dist/index.js';

function nested() {
  const calls = [];
  const leaf = id => action({ id, tick: c => { calls.push(id); return c.success(); } });
  const tree = sequence({ id: 'root', steps: [
    { node: sequence({ id: 'inner', steps: [{ node: leaf('a') }, { node: leaf('b') }] }) },
    { node: leaf('outside') }
  ] });
  const debug = createDebugger(createRunner(tree));
  debug.command({ type: 'setBreakpoint', nodeId: 'a' }); debug.command({ type: 'tick' });
  return { debug, calls };
}

test('step over completes selected activation without executing its next sibling', () => {
  const { debug, calls } = nested();
  const tick = debug.snapshot().runner.tick;
  assert.equal(debug.command({ type: 'stepOver' }).ok, true);
  assert.deepEqual(calls, ['a']); assert.equal(debug.snapshot().runner.paused, true);
  assert.equal(debug.snapshot().stepResult.reason, 'target-left');
  assert.equal(debug.snapshot().runner.tick, tick);
});

test('step out completes the selected activation parent without executing its outer sibling', () => {
  const { debug, calls } = nested();
  assert.equal(debug.command({ type: 'stepOut' }).ok, true);
  assert.deepEqual(calls, ['a', 'b']); assert.equal(debug.snapshot().stepResult.reason, 'target-left');
  assert.deepEqual(debug.snapshot().runner.frames.map(f => f.nodeId), ['root']);
});

test('breakpoints inside a stepped subtree interrupt step-over/out', () => {
  const { debug, calls } = nested();
  debug.command({ type: 'setBreakpoint', nodeId: 'b' });
  debug.command({ type: 'stepOut' });
  assert.deepEqual(calls, ['a']); assert.equal(debug.snapshot().stepResult.reason, 'breakpoint');
  assert.equal(debug.snapshot().breakpointHit.nodeId, 'b');
});

test('blocked steps return promptly and ready callback continuations can finish a later step', () => {
  let token;
  const debug = createDebugger(createRunner(action({ id: 'wait', enter(c) {
    token = c.wait.callback({ resume: 'done' }); return token.wait;
  }, resume: { done: c => c.success(42) } })));
  debug.command({ type: 'stepInto' }); debug.command({ type: 'stepOver' });
  assert.equal(debug.snapshot().stepResult.reason, 'blocked');
  debug.command({ type: 'stepOver' }); assert.equal(debug.snapshot().stepResult.transitions, 0);
  token.resolve(); debug.command({ type: 'stepOver' });
  assert.equal(debug.snapshot().runner.output, 42); assert.equal(debug.snapshot().stepResult.reason, 'terminal');
});

test('RUNNING actions are not spun and long synchronous work is bounded by step budget', () => {
  let calls = 0;
  const debug = createDebugger(createRunner(action({ id: 'run', tick() { calls++; return RUNNING; } })));
  debug.command({ type: 'stepInto' }); debug.command({ type: 'stepOver' });
  assert.equal(calls, 1); assert.equal(debug.snapshot().stepResult.reason, 'blocked');
  const looping = createDebugger(createRunner(repeat({ id: 'repeat', times: Infinity,
    child: action({ id: 'instant', tick: c => c.success() }) })), { stepBudget: 7 });
  looping.command({ type: 'stepInto' }); looping.command({ type: 'stepOver' });
  assert.equal(looping.snapshot().stepResult.reason, 'budget');
  assert.equal(looping.snapshot().stepResult.transitions, 7); assert.equal(looping.snapshot().runner.paused, true);
});

test('selected parallel activations are distinguished by activation ID', () => {
  const shared = action({ id: 'shared', tick: c => c.input ? c.success() : RUNNING });
  const debug = createDebugger(createRunner(parallel({ id: 'p', successThreshold: 2, failureThreshold: 1,
    steps: [{ node: shared, input: () => false }, { node: shared, input: () => true }] })));
  debug.command({ type: 'setBreakpoint', nodeId: 'shared' }); debug.command({ type: 'tick' });
  const first = debug.snapshot().breakpointHit.activationId;
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  const second = debug.snapshot().breakpointHit.activationId;
  debug.command({ type: 'stepOver' });
  assert.equal(debug.snapshot().stepResult.targetActivationId, second);
  assert.ok(debug.snapshot().runner.frames.some(f => f.activationId === first));
  assert.ok(!debug.snapshot().runner.frames.some(f => f.activationId === second));
});

test('invalid stepping states and budgets do not execute actions', () => {
  const runner = createRunner(action({ id: 'root', tick: () => RUNNING }));
  const debug = createDebugger(runner);
  assert.equal(debug.command({ type: 'stepOver' }).code, 'INVALID_STATE');
  debug.command({ type: 'pause' }); assert.equal(debug.command({ type: 'stepOver' }).code, 'INVALID_STATE');
  debug.command({ type: 'stepInto' }); assert.equal(debug.command({ type: 'stepOut' }).code, 'INVALID_STATE');
  for (const stepBudget of [0, -1, NaN, Infinity, 10001]) assert.throws(() => createDebugger(runner, { stepBudget }), /step budget/);
});
