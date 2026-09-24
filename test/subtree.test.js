import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, selector, subtree, createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

test('shared subtree calls isolate scopes, locals, inputs, and output bindings', () => {
  const shared = sequence({ id: 'shared', steps: [
    { node: action({ id: 'leaf', tick(c) {
      assert.equal(c.local.visits, undefined); c.local.visits = 1;
      return c.success(c.input * 2);
    } }), save: 'private' }
  ], output: s => s.vars.private });
  const call = (id, multiplier) => subtree({ id, child: shared,
    input: s => { assert.deepEqual(Object.keys(s.vars), []); return s.input * multiplier; },
    output: (s, result) => {
      assert.equal(s.vars.private, undefined); assert.equal(result.status, SUCCESS);
      return { value: s.last, original: s.input };
    }
  });
  const tree = sequence({ id: 'root', steps: [
    { node: call('first', 1), save: 'first' }, { node: call('second', 3), save: 'second' }
  ], output: s => s.vars });
  const a = createRunner(tree, { input: 2 }), b = createRunner(tree, { input: 5 });
  assert.deepEqual({ ...a.tick().output }, { first: { value: 4, original: 2 }, second: { value: 12, original: 2 } });
  assert.deepEqual({ ...b.tick().output }, { first: { value: 10, original: 5 }, second: { value: 30, original: 5 } });
});

test('subtree output mappings preserve failure status and expose a readonly completion', () => {
  const runner = createRunner(subtree({ id: 'call', child: action({ id: 'leaf', enter: c => c.failure('reason') }),
    output: (s, result) => {
      assert.ok(Object.isFrozen(result)); return { reason: result.output, last: s.last };
    }
  }));
  const state = runner.tick();
  assert.equal(state.status, FAILURE); assert.deepEqual(state.output, { reason: 'reason', last: 'reason' });
  const value = { shared: true };
  const passthrough = createRunner(subtree({ id: 'call', child: action({ id: 'leaf', enter: c => c.success(c.input) }) }), { input: value });
  assert.equal(passthrough.tick().output, value);
});

test('reactive subtree reentry retains child input, activation, and local progress', () => {
  let input = 1, bindings = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: subtree({ id: 'call', child: action({ id: 'work', tick(c) {
      c.local.calls = (c.local.calls ?? 0) + 1; return RUNNING;
    } }), input: () => { bindings++; return input; } }) }
  ] }));
  runner.tick(); const first = runner.snapshot().frames.at(-1);
  input = 2; runner.tick(); const second = runner.snapshot().frames.at(-1);
  assert.equal(second.input, 1); assert.equal(bindings, 1);
  assert.equal(second.activationId, first.activationId); assert.equal(second.local.calls, 2);
});

test('parent activation IDs distinguish simultaneous shared-definition calls during preemption', () => {
  let priority = false, cancelled = 0;
  const shared = action({ id: 'shared', tick: () => RUNNING, cancel: () => { cancelled++; } });
  const runner = createRunner(selector({ id: 'root', reactive: true, steps: [
    { node: sequence({ id: 'urgent', steps: [
      { node: action({ id: 'guard', tick: () => priority ? SUCCESS : FAILURE }) },
      { node: subtree({ id: 'urgent-call', child: shared }) }
    ] }) },
    { node: subtree({ id: 'normal-call', child: shared }) }
  ] }));
  runner.tick(); priority = true;
  for (let i = 0; i < 15; i++) {
    if (runner.snapshot().frames.filter(f => f.nodeId === 'shared').length === 2) break;
    runner.step();
  }
  const state = runner.snapshot(), leaves = state.frames.filter(f => f.nodeId === 'shared');
  assert.equal(leaves.length, 2);
  assert.notEqual(leaves[0].activationId, leaves[1].activationId);
  assert.notEqual(leaves[0].parentActivationId, leaves[1].parentActivationId);
  assert.deepEqual(leaves.map(f => state.frames.find(p => p.activationId === f.parentActivationId).nodeId).sort(), ['normal-call', 'urgent-call']);
  runner.cancel(); assert.equal(cancelled, 1); // New leaf was entered but its callback has not run.
});

test('subtree waits keep their resources across reevaluation and release on cancellation', () => {
  let emit, bindings = 0, disposed = 0;
  const runner = createRunner(subtree({ id: 'call', reactive: true, input: s => { bindings++; return s.input; },
    child: action({ id: 'wait', enter: c => c.wait.event(fn => { emit = fn; return () => { disposed++; }; }, { resume: 'done' }),
      resume: { done: () => assert.fail('Cancelled wait must not resume') } })
  }));
  runner.tick(); runner.tick(); assert.equal(bindings, 1);
  emit('queued'); runner.cancel(); emit('late');
  assert.equal(disposed, 1); assert.equal(runner.snapshot().queuedResumes, 0);
});

test('subtree entry and completion mapping remain separate debugger transitions', () => {
  let mapped = 0;
  const runner = createRunner(subtree({ id: 'call', child: action({ id: 'leaf', tick: () => SUCCESS }),
    output: () => ++mapped }), { maxStepsPerTick: 1 });
  for (let i = 1; i <= 4; i++) {
    const state = runner.step(); assert.equal(state.transitions, i);
    assert.equal(mapped, i === 4 ? 1 : 0);
    assert.equal(state.status, i === 4 ? SUCCESS : RUNNING);
  }
});

test('subtree binding errors stop execution and definitions validate bindings', () => {
  const child = action({ id: 'child', tick: () => SUCCESS });
  for (const key of ['input', 'output']) {
    assert.throws(() => subtree({ id: 'bad', child, [key]: 42 }), /binding/);
    const error = new Error(key);
    const runner = createRunner(subtree({ id: 'call', child, [key]: () => { throw error; } }));
    assert.equal(runner.tick().status, 'errored'); assert.equal(runner.snapshot().error, error);
  }
  const tree = subtree({ id: 'call', child }); assert.ok(Object.isFrozen(tree));
  assert.equal(tree.child, child);
  const cycle = { type: 'subtree', id: 'cycle' }; cycle.child = cycle;
  assert.throws(() => createRunner(cycle), /Cyclic/);
});
