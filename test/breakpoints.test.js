import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, parallel, repeat, createRunner, createDebugger, RUNNING } from '../dist/index.js';

test('entry breakpoint stops before side effects; continue executes the held boundary once', () => {
  let calls = 0;
  const debug = createDebugger(createRunner(action({ id: 'work', tick() { calls++; return RUNNING; } })));
  assert.equal(debug.command({ type: 'setBreakpoint', nodeId: 'work' }).ok, true);
  debug.command({ type: 'tick' });
  assert.equal(calls, 0); assert.equal(debug.snapshot().runner.paused, true);
  assert.equal(debug.snapshot().runner.transitions, 1);
  assert.equal(debug.snapshot().breakpointHit.nodeId, 'work');
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  assert.equal(calls, 1); assert.equal(debug.snapshot().breakpointHit, null);
  debug.command({ type: 'tick' }); assert.equal(calls, 2); assert.equal(debug.snapshot().runner.paused, false);
});

test('step passes a held breakpoint and new activations hit again', () => {
  let calls = 0;
  const debug = createDebugger(createRunner(repeat({ id: 'repeat', times: 2,
    child: action({ id: 'work', tick: c => { calls++; return c.success(); } }) })));
  debug.command({ type: 'setBreakpoint', nodeId: 'work' }); debug.command({ type: 'tick' });
  const first = debug.snapshot().breakpointHit.activationId;
  debug.command({ type: 'stepInto' }); assert.equal(calls, 1); assert.equal(debug.snapshot().breakpointHit, null);
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  // Repeat yields between iterations; the next drive creates the next activation.
  if (!debug.snapshot().breakpointHit) debug.command({ type: 'tick' });
  assert.equal(calls, 1); assert.notEqual(debug.snapshot().breakpointHit.activationId, first);
  debug.command({ type: 'removeBreakpoint', nodeId: 'work' });
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  assert.equal(calls, 2); assert.equal(debug.snapshot().runner.status, 'SUCCESS');
});

test('conditional breakpoints use captured input and do not invoke accessors', () => {
  let calls = 0;
  const leaf = action({ id: 'work', tick: c => { calls++; return c.success(); } });
  const tree = sequence({ id: 'root', steps: [
    { node: leaf, input: () => ({ mode: 'other' }) },
    { node: leaf, input: () => ({ get mode() { assert.fail('getter'); } }) },
    { node: leaf, input: () => ({ mode: 'combat' }) }
  ] });
  const debug = createDebugger(createRunner(tree));
  const inputPath = ['mode'];
  debug.command({ type: 'setBreakpoint', nodeId: 'work', inputPath, equals: 'combat' }); inputPath[0] = 'changed';
  debug.command({ type: 'tick' });
  assert.equal(calls, 2); assert.equal(debug.snapshot().breakpointHit.nodeId, 'work');
  assert.deepEqual(debug.snapshot().selection.input, { mode: 'combat' });
});

test('parallel shared definitions have distinct entry stops and disposal releases hooks', () => {
  const leaf = action({ id: 'shared', tick: () => RUNNING });
  const runner = createRunner(parallel({ id: 'p', successThreshold: 2, failureThreshold: 1, steps: [{ node: leaf }, { node: leaf }] }));
  const debug = createDebugger(runner);
  debug.command({ type: 'setBreakpoint', nodeId: 'shared' }); debug.command({ type: 'tick' });
  const first = debug.snapshot().breakpointHit.activationId;
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  assert.notEqual(debug.snapshot().breakpointHit.activationId, first);
  debug.dispose(); runner.continue(); runner.tick(); assert.equal(runner.snapshot().paused, false);
});

test('invalid breakpoint conditions do not mutate controller state', () => {
  const debug = createDebugger(createRunner(action({ id: 'a', tick: () => RUNNING })));
  const accessorPath = []; Object.defineProperty(accessorPath, '0', { get() { assert.fail('getter'); } });
  for (const fields of [{ nodeId: '' }, { nodeId: 'a', inputPath: [] }, { nodeId: 'a', equals: 1 },
    { nodeId: 'a', inputPath: ['x'], equals: {} }, { nodeId: 'a', inputPath: accessorPath, equals: true },
    { nodeId: 'a', inputPath: [], equals: Infinity }]) {
    assert.equal(debug.command({ type: 'setBreakpoint', ...fields }).code, 'INVALID_COMMAND');
  }
  assert.equal(debug.snapshot().breakpoints.length, 0);
});

test('entry observer errors are isolated and a paused entry does not consume a transition', () => {
  const errors = []; let calls = 0;
  const runner = createRunner(action({ id: 'a', tick: c => { calls++; return c.success(); } }), { onEventError: e => errors.push(e) });
  runner.beforeEnter(() => { throw Error('observer'); });
  const off = runner.beforeEnter(() => true);
  runner.tick(); assert.equal(calls, 0); assert.equal(errors.length, 1); assert.equal(runner.snapshot().transitions, 1);
  off(); runner.step(); assert.equal(calls, 1); assert.equal(runner.snapshot().transitions, 2);
});
