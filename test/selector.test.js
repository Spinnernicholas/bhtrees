import test from 'node:test';
import assert from 'node:assert/strict';
import { action, condition, selector, sequence, createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

const frame = (runner, id) => runner.snapshot().frames.find(item => item.nodeId === id);

test('conditions receive activation data, return boolean statuses, and isolate runners', () => {
  const tree = condition({ id: 'guard', test(ctx) {
    assert.equal(ctx.local.visits, undefined);
    ctx.local.visits = 1;
    return ctx.services.allowed(ctx.input);
  } });
  assert.equal(tree.type, 'condition');
  assert.ok(Object.isFrozen(tree));
  const services = { allowed: value => value === 'yes' };
  assert.equal(createRunner(tree, { input: 'yes', services }).tick().status, SUCCESS);
  assert.equal(createRunner(tree, { input: 'no', services }).tick().status, FAILURE);
});

test('conditions reject non-booleans and async predicates without unhandled rejections', async () => {
  for (const value of [1, 'yes', null, undefined, SUCCESS, { status: SUCCESS }, Promise.reject(new Error('async'))]) {
    const state = createRunner(condition({ id: 'bad', test: () => value })).tick();
    assert.equal(state.status, 'errored');
    assert.match(state.error.message, /synchronous boolean/);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('selector validates definitions and bindings', () => {
  assert.throws(() => selector({ id: '', steps: [] }), /Selectors/);
  assert.throws(() => selector({ id: 's', steps: null }), /Selectors/);
  assert.throws(() => selector({ id: 's', steps: [], output: 42 }), /Selectors/);
  assert.throws(() => condition({ id: '', test: () => true }), /Conditions/);
  assert.throws(() => condition({ id: 'c', test: true }), /Conditions/);
  for (const reactive of [null, 'inherit', 1]) {
    assert.throws(() => selector({ id: 's', steps: [], reactive }), /reactive/);
    assert.throws(() => condition({ id: 'c', test: () => true, reactive }), /reactive/);
  }
  const node = condition({ id: 'c', test: () => true });
  const steps = [{ node }];
  const tree = selector({ id: 's', steps });
  steps.push({ node }); steps[0].save = 'changed';
  assert.equal(tree.steps.length, 1);
  assert.equal(tree.steps[0].save, undefined);
  assert.ok(Object.isFrozen(tree) && Object.isFrozen(tree.steps) && Object.isFrozen(tree.steps[0]));
  for (const binding of [{ input: true }, { save: 1 }]) {
    assert.throws(() => createRunner(selector({ id: 's', steps: [{ node, ...binding }] })), /binding/);
  }
  assert.throws(() => createRunner(selector({ id: 's', steps: [
    { node }, { node: condition({ id: 'c', test: () => false }) }
  ] })), /Duplicate node id/);
  const cycle = { type: 'selector', id: 'cycle', steps: [] };
  cycle.steps.push({ node: cycle });
  assert.throws(() => createRunner(cycle), /Cyclic/);
});

test('selector short circuits on success and maps only successful outputs into saved scope', () => {
  const visited = [];
  const runner = createRunner(selector({ id: 's', steps: [
    { node: action({ id: 'first', enter: c => { visited.push('first'); return c.failure('retry'); } }), save: 'failed' },
    { node: action({ id: 'winner', enter: c => { visited.push('winner'); return c.success(c.input); } }),
      input: s => ({ previous: s.last, root: s.input }), save: 'winner' },
    { node: action({ id: 'unused', tick: () => assert.fail('Must short circuit') }) }
  ], output: s => ({ winner: s.vars.winner, last: s.last, saved: Object.keys(s.vars) }) }), { input: 'root' });
  const state = runner.tick();
  assert.equal(state.status, SUCCESS);
  assert.deepEqual(visited, ['first', 'winner']);
  assert.deepEqual(state.output, { winner: { previous: 'retry', root: 'root' },
    last: { previous: 'retry', root: 'root' }, saved: ['winner'] });
  runner.tick(); assert.equal(visited.length, 2);
});

test('empty selectors fail and exhausted selectors propagate the last failure output', () => {
  const output = () => assert.fail('Output mapper only runs on success');
  assert.equal(createRunner(selector({ id: 'empty', steps: [], output })).tick().status, FAILURE);
  const state = createRunner(selector({ id: 's', output, steps: [
    { node: condition({ id: 'no', test: () => false }) },
    { node: action({ id: 'failed', enter: c => c.failure({ reason: 'unavailable' }) }) }
  ] })).tick();
  assert.equal(state.status, FAILURE);
  assert.deepEqual(state.output, { reason: 'unavailable' });
});

test('memory selectors retain running children and continue to fallback after failure', () => {
  for (const reactive of [false, 'inherited']) {
    let checked = 0, calls = 0;
    const runner = createRunner(selector({ id: 's', reactive, steps: [
      { node: condition({ id: 'guard', test: () => { checked++; return false; } }) },
      { node: action({ id: 'work', tick: () => ++calls < 3 ? RUNNING : FAILURE }) },
      { node: action({ id: 'fallback', tick: c => c.success('fallback') }) }
    ] }));
    runner.tick(); const first = frame(runner, 'work');
    runner.tick(); assert.equal(frame(runner, 'work').activationId, first.activationId);
    assert.equal(runner.tick().output, 'fallback');
    assert.equal(checked, 1); assert.equal(calls, 3);
  }
});

test('reactive selectors preserve reached waits and discard queued/late results when preempted', () => {
  let highPriority = false, emit, entered = 0;
  const cleanup = [];
  const runner = createRunner(selector({ id: 's', reactive: true, steps: [
    { node: condition({ id: 'priority', test: () => highPriority }) },
    { node: sequence({ id: 'branch', steps: [
      { node: action({ id: 'wait', enter(c) {
        entered++;
        return c.wait.event(fn => { emit = fn; return () => cleanup.push('dispose'); }, { resume: 'done' });
      }, resume: { done: () => assert.fail('Preempted result must not resume') },
      cancel: (c, reason) => cleanup.push(reason) }) }
    ] }) }
  ] }));
  runner.tick(); const first = frame(runner, 'wait');
  runner.tick(); assert.equal(frame(runner, 'wait').activationId, first.activationId);
  assert.equal(entered, 1);
  emit('queued'); highPriority = true;
  assert.equal(runner.tick().status, SUCCESS);
  emit('late');
  assert.equal(runner.snapshot().queuedResumes, 0);
  assert.deepEqual(cleanup, ['dispose', 'interrupted']);
  runner.cancel(); assert.equal(cleanup.length, 2);
});

test('an earlier RUNNING selector child preempts the old branch and later reentry is fresh', () => {
  let priority = false, cancelled = 0;
  const runner = createRunner(selector({ id: 's', reactive: true, steps: [
    { node: action({ id: 'priority', tick: () => priority ? RUNNING : FAILURE }) },
    { node: action({ id: 'work', tick(c) { c.local.count = (c.local.count ?? 0) + 1; return RUNNING; },
      cancel() { cancelled++; } }) }
  ] }));
  runner.tick(); const first = frame(runner, 'work');
  runner.tick(); assert.equal(frame(runner, 'work').local.count, 2);
  priority = true; runner.tick();
  assert.equal(cancelled, 1); assert.equal(frame(runner, 'work'), undefined);
  priority = false; runner.tick();
  assert.notEqual(frame(runner, 'work').activationId, first.activationId);
  assert.equal(frame(runner, 'work').local.count, 1);
});

test('selectors inherit reactivity and explicit memory overrides reactive ancestors', () => {
  for (const reactive of ['inherited', false]) {
    let checked = 0;
    const runner = createRunner(sequence({ id: 'parent', reactive: true, steps: [
      { node: selector({ id: 's', reactive, steps: [
        { node: condition({ id: 'guard', test: () => { checked++; return false; } }) },
        { node: action({ id: 'work', tick: () => RUNNING }) }
      ] }) }
    ] }));
    runner.tick(); runner.tick();
    assert.equal(checked, reactive === false ? 1 : 2);
    assert.equal(frame(runner, 'work').effectiveReactive, reactive !== false);
  }
});

test('selectors finish traversal across debugger steps and single-transition budgets', () => {
  for (const manual of [false, true]) {
    let checks = 0, calls = 0;
    const runner = createRunner(selector({ id: 's', reactive: true, steps: [
      { node: condition({ id: 'guard', test: () => { checks++; return false; } }) },
      { node: action({ id: 'work', tick: () => ++calls < 3 ? RUNNING : SUCCESS }) }
    ] }), { maxStepsPerTick: 1 });
    for (let i = 0; i < 100 && runner.snapshot().status !== SUCCESS; i++) {
      const before = runner.snapshot().transitions;
      const state = manual ? runner.step() : runner.tick();
      assert.equal(state.transitions, before + 1);
    }
    assert.equal(runner.snapshot().status, SUCCESS);
    assert.equal(checks, 3); assert.equal(calls, 3);
  }
});

test('selector errors are not fallback failures and preempted cleanup errors remain errors', () => {
  const error = new Error('predicate failed');
  const state = createRunner(selector({ id: 's', steps: [
    { node: condition({ id: 'throw', test: () => { throw error; } }) },
    { node: action({ id: 'fallback', tick: () => assert.fail('Errors must stop execution') }) }
  ] })).tick();
  assert.equal(state.status, 'errored'); assert.equal(state.error, error);
  let priority = false, cancelled = 0;
  const runner = createRunner(selector({ id: 's', reactive: true, steps: [
    { node: condition({ id: 'guard', test: () => priority }) },
    { node: action({ id: 'wait', enter: c => c.wait.event(() => () => { throw error; }, { resume: 'done' }),
      resume: { done: () => SUCCESS }, cancel() { cancelled++; } }) }
  ] }));
  runner.tick(); priority = true;
  assert.equal(runner.tick().status, 'errored');
  assert.equal(cancelled, 1); assert.equal(runner.snapshot().frames.length, 0);
});
