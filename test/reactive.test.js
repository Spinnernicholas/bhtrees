import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

const frame = (runner, id) => runner.snapshot().frames.find(item => item.nodeId === id);

test('reactive sequences revisit guards and retain a reached running activation', () => {
  let guards = 0, cancelled = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', tick() { guards++; return SUCCESS; } }) },
    { node: action({ id: 'work', tick(c) { c.local.count = (c.local.count ?? 0) + 1; return RUNNING; },
      cancel() { cancelled++; } }) }
  ] }));
  runner.tick();
  const first = frame(runner, 'work');
  runner.tick();
  assert.equal(guards, 2);
  assert.equal(frame(runner, 'work').activationId, first.activationId);
  assert.equal(frame(runner, 'work').local.count, 2);
  assert.equal(cancelled, 0);
  runner.cancel();
  assert.equal(cancelled, 1);
});

test('inherited defaults to memory at the root and explicit false overrides a reactive parent', () => {
  for (const reactive of [false, 'inherited']) {
    let guards = 0;
    const runner = createRunner(sequence({ id: 'root', reactive, steps: [
      { node: action({ id: 'guard', tick() { guards++; return SUCCESS; } }) },
      { node: action({ id: 'work', tick: () => RUNNING }) }
    ] }));
    runner.tick(); runner.tick();
    assert.equal(guards, 1);
    assert.equal(frame(runner, 'work').effectiveReactive, false);
  }
  let outer = 0, inner = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'outer', tick() { outer++; return SUCCESS; } }) },
    { node: sequence({ id: 'memory', reactive: false, steps: [
      { node: action({ id: 'inner', tick() { inner++; return SUCCESS; } }) },
      { node: action({ id: 'work', tick: () => RUNNING }) }
    ] }) }
  ] }));
  runner.tick(); runner.tick();
  assert.equal(outer, 2);
  assert.equal(inner, 1);
  assert.equal(frame(runner, 'work').effectiveReactive, false);
});

test('nested nodes inherit true and explicit true works under a memory parent', () => {
  for (const parentReactive of [true, false]) {
    let guards = 0;
    const runner = createRunner(sequence({ id: 'root', reactive: parentReactive, steps: [
      { node: sequence({ id: 'nested', reactive: parentReactive ? 'inherited' : true, steps: [
        { node: action({ id: 'guard', tick() { guards++; return SUCCESS; } }) },
        { node: action({ id: 'work', tick: () => RUNNING }) }
      ] }) }
    ] }));
    runner.tick(); runner.tick();
    assert.equal(guards, 2);
    assert.equal(frame(runner, 'work').effectiveReactive, true);
  }
});

test('a failing earlier guard interrupts the old running child exactly once', () => {
  let allowed = true;
  const reasons = [];
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', tick: () => allowed ? SUCCESS : FAILURE }) },
    { node: action({ id: 'work', tick: () => RUNNING, cancel(c, reason) { reasons.push(reason); } }) }
  ] }));
  runner.tick(); allowed = false;
  assert.equal(runner.tick().status, FAILURE);
  assert.deepEqual(reasons, ['interrupted']);
  runner.cancel(); assert.equal(reasons.length, 1);
  assert.equal(runner.snapshot().frames.length, 0);
});

test('an earlier RUNNING child interrupts the old branch and later reentry is fresh', () => {
  let earlierRunning = false, cancelled = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', tick: () => earlierRunning ? RUNNING : SUCCESS }) },
    { node: action({ id: 'work', tick(c) { c.local.count = (c.local.count ?? 0) + 1; return RUNNING; },
      cancel() { cancelled++; } }) }
  ] }));
  runner.tick(); const first = frame(runner, 'work');
  earlierRunning = true; runner.tick();
  assert.equal(cancelled, 1);
  assert.equal(frame(runner, 'work'), undefined);
  earlierRunning = false; runner.tick();
  assert.notEqual(frame(runner, 'work').activationId, first.activationId);
  assert.equal(frame(runner, 'work').local.count, 1);
});

test('reactivity preserves waits and queued events while revisiting earlier children', () => {
  let emit, entered = 0, disposed = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', tick: () => SUCCESS }) },
    { node: action({ id: 'wait', enter(c) {
      entered++;
      return c.wait.event(fn => { emit = fn; return () => { disposed++; }; }, { resume: 'done' });
    }, resume: { done: (c, value) => c.success(value) } }) }
  ] }));
  runner.tick(); runner.tick();
  assert.equal(entered, 1); assert.equal(disposed, 0);
  emit(42);
  assert.equal(runner.tick().output, 42);
  assert.equal(disposed, 1);
});

test('interrupting a wait disposes before cancel and rejects late notifications', () => {
  let allowed = true, emit;
  const cleanup = [];
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', tick: () => allowed ? SUCCESS : FAILURE }) },
    { node: action({ id: 'wait', enter: c => c.wait.event(fn => {
      emit = fn; return () => { cleanup.push('dispose'); };
    }, { resume: 'done' }), resume: { done() { assert.fail('Must not resume'); } },
    cancel() { cleanup.push('cancel'); } }) }
  ] }));
  runner.tick(); emit('queued'); allowed = false;
  assert.equal(runner.tick().status, FAILURE);
  emit('late');
  assert.equal(runner.snapshot().queuedResumes, 0);
  assert.deepEqual(cleanup, ['dispose', 'cancel']);
});



test('debugger steps and small budgets finish a traversal without repeatedly rewinding it', () => {
  for (const manual of [true, false]) {
    let guards = 0, work = 0;
    const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
      { node: action({ id: 'guard', tick() { guards++; return SUCCESS; } }) },
      { node: action({ id: 'work', tick() { return ++work === 3 ? SUCCESS : RUNNING; } }) }
    ] }), { maxStepsPerTick: 1 });
    for (let i = 0; i < 100 && runner.snapshot().status !== SUCCESS; i++) {
      const before = runner.snapshot().transitions;
      const state = manual ? runner.step() : runner.tick();
      assert.equal(state.transitions, before + 1);
      if (manual) assert.equal(state.paused, true);
    }
    assert.equal(runner.snapshot().status, SUCCESS);
    assert.equal(guards, 3); assert.equal(work, 3);
  }
});

test('interruption cleanup failures still release the subtree and report an error', () => {
  let allowed = true, cancelled = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', tick: () => allowed ? SUCCESS : FAILURE }) },
    { node: action({ id: 'wait', enter: c => c.wait.event(() => () => { throw new Error('dispose'); }, { resume: 'done' }),
      resume: { done: () => SUCCESS }, cancel() { cancelled++; } }) }
  ] }));
  runner.tick(); allowed = false;
  assert.equal(runner.tick().status, 'errored');
  assert.equal(cancelled, 1);
  assert.equal(runner.snapshot().frames.length, 0);
});

test('all node constructors validate the tri-state reactive option', () => {
  for (const reactive of [null, 0, 'true', 'inherit']) {
    assert.throws(() => action({ id: 'a', tick: () => SUCCESS, reactive }), /reactive/);
    assert.throws(() => sequence({ id: 's', steps: [], reactive }), /reactive/);
  }
});

test('reactive traversal preserves composite data and retained child inputs', () => {
  let value = 1, bindings = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'read', tick: c => c.success(value) }), save: 'value' },
    { node: action({ id: 'work', tick: () => RUNNING }), input: scope => { bindings++; return scope.vars.value; } }
  ] }));
  runner.tick(); value = 2; runner.tick();
  assert.equal(frame(runner, 'root').vars.value, 2);
  assert.equal(frame(runner, 'work').input, 1);
  assert.equal(bindings, 1);
});


test('cancel cleans up both retained and newly visited waits during partial traversal', () => {
  let guardRunning = false, oldDisposed = 0, newDisposed = 0;
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', enter: c => guardRunning
      ? c.wait.event(() => () => { newDisposed++; }, { resume: 'done' }) : SUCCESS,
      resume: { done: () => SUCCESS } }) },
    { node: action({ id: 'work', enter: c => c.wait.event(() => () => { oldDisposed++; }, { resume: 'done' }),
      resume: { done: () => SUCCESS } }) }
  ] }));
  runner.tick(); guardRunning = true;
  runner.step(); runner.step(); // Enter the earlier wait, before resolving traversal.
  assert.equal(oldDisposed, 0);
  assert.equal(frame(runner, 'work').onTraversal, false);
  runner.cancel();
  assert.equal(oldDisposed, 1); assert.equal(newDisposed, 1);
  assert.equal(runner.snapshot().frames.length, 0);
});
