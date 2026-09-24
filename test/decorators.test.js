import test from 'node:test';
import assert from 'node:assert/strict';
import { action, condition, sequence, selector, inverter, forceSuccess, forceFailure,
  createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

const decorators = [inverter, forceSuccess, forceFailure];
const expected = (wrap, status) => wrap === inverter ? status === SUCCESS ? FAILURE : SUCCESS
  : wrap === forceSuccess ? SUCCESS : FAILURE;

for (const wrap of decorators) {
  test(`${wrap.name} transforms terminal status and preserves input/output identity`, () => {
    for (const status of [SUCCESS, FAILURE]) {
      const value = { payload: 42 };
      const tree = wrap({ id: 'wrapper', child: action({ id: 'leaf', enter: c => ({ status, output: c.input }) }) });
      assert.ok(Object.isFrozen(tree));
      const runner = createRunner(tree, { input: value });
      const result = runner.tick();
      assert.equal(result.status, expected(wrap, status));
      assert.equal(result.output, value);
      assert.equal(result.frames.length, 0);
      assert.equal(runner.tick().status, result.status);
    }
  });

  test(`${wrap.name} preserves RUNNING activations until child completion`, () => {
    const runner = createRunner(wrap({ id: 'wrapper', child: action({ id: 'leaf', tick(c) {
      c.local.calls = (c.local.calls ?? 0) + 1;
      return c.local.calls < 3 ? RUNNING : c.success(c.local.calls);
    } }) }));
    const first = runner.tick();
    assert.equal(first.status, RUNNING);
    const second = runner.tick();
    assert.equal(second.status, RUNNING);
    assert.equal(second.frames.at(-1).activationId, first.frames.at(-1).activationId);
    assert.equal(second.frames.at(-1).local.calls, 2);
    const result = runner.tick();
    assert.equal(result.status, expected(wrap, SUCCESS));
    assert.equal(result.output, 3);
  });

  test(`${wrap.name} waits through pause and transforms named continuation results`, () => {
    let emit, disposed = 0;
    const runner = createRunner(wrap({ id: 'wrapper', child: action({ id: 'leaf',
      enter: c => c.wait.event(fn => { emit = fn; return () => { disposed++; }; }, { resume: 'done' }),
      resume: { done: (c, value) => c.failure(value) }
    }) }));
    runner.tick(); runner.pause(); emit('result');
    assert.equal(runner.tick().status, RUNNING);
    assert.equal(disposed, 0);
    runner.continue();
    const result = runner.tick();
    assert.equal(result.status, expected(wrap, FAILURE));
    assert.equal(result.output, 'result'); assert.equal(disposed, 1);
  });

  test(`${wrap.name} does not convert exceptions or cancellation into behavior results`, () => {
    const error = new Error('failure');
    const result = createRunner(wrap({ id: 'wrapper', child: condition({ id: 'leaf', test: () => { throw error; } }) })).tick();
    assert.equal(result.status, 'errored'); assert.equal(result.error, error);
    let emit;
    const cleanup = [];
    const runner = createRunner(wrap({ id: 'wrapper', child: action({ id: 'leaf',
      enter: c => c.wait.event(fn => { emit = fn; return () => cleanup.push('dispose'); }, { resume: 'done' }),
      resume: { done: () => assert.fail('Cancelled work must not resume') },
      cancel: (c, reason) => cleanup.push(reason)
    }) }));
    runner.tick(); emit('queued');
    assert.equal(runner.cancel('stop').status, 'cancelled');
    emit('late'); runner.cancel();
    assert.equal(runner.tick().queuedResumes, 0);
    assert.deepEqual(cleanup, ['dispose', 'stop']);
  });
}

test('decorators inherit reactivity and allow a memory override for descendants', () => {
  for (const reactive of ['inherited', false, true]) {
    let checks = 0;
    const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
      { node: forceSuccess({ id: 'wrapper', reactive, child: sequence({ id: 'branch', steps: [
        { node: condition({ id: 'guard', test: () => { checks++; return true; } }) },
        { node: action({ id: 'work', tick: () => RUNNING }) }
      ] }) }) }
    ] }));
    runner.tick(); const first = runner.snapshot().frames.at(-1);
    runner.tick();
    assert.equal(checks, reactive === false ? 1 : 2);
    assert.equal(runner.snapshot().frames.at(-1).activationId, first.activationId);
  }
});

test('reactive priority preemption cancels work nested inside decorators', () => {
  let priority = false, cancelled = 0;
  const runner = createRunner(selector({ id: 'root', reactive: true, steps: [
    { node: condition({ id: 'priority', test: () => priority }) },
    { node: inverter({ id: 'outer', child: forceFailure({ id: 'inner', child: action({ id: 'work',
      tick: () => RUNNING, cancel(c, reason) { assert.equal(reason, 'interrupted'); cancelled++; }
    }) }) }) }
  ] }));
  runner.tick(); priority = true;
  assert.equal(runner.tick().status, SUCCESS);
  assert.equal(cancelled, 1); assert.equal(runner.snapshot().frames.length, 0);
});

test('nested decorators expose separate child-completion and result-transform steps', () => {
  for (const manual of [false, true]) {
    let calls = 0;
    const runner = createRunner(inverter({ id: 'outer', child: forceFailure({ id: 'inner',
      child: action({ id: 'leaf', tick: () => { calls++; return SUCCESS; } })
    }) }), { maxStepsPerTick: 1 });
    const drive = () => manual ? runner.step() : runner.tick();
    for (let i = 1; i <= 6; i++) {
      const state = drive();
      assert.equal(state.transitions, i);
      assert.equal(state.status, i === 6 ? SUCCESS : RUNNING);
      if (i === 4) assert.equal(state.frames.at(-1).nodeId, 'inner');
      if (i === 5) assert.equal(state.frames.at(-1).nodeId, 'outer');
    }
    assert.equal(calls, 1);
  }
});

test('decorators validate child definitions, cycles, IDs, and reactive settings', () => {
  for (const wrap of decorators) {
    assert.throws(() => wrap({ id: 'bad' }), /child/);
    assert.throws(() => wrap({ id: '', child: condition({ id: 'c', test: () => true }) }), /id/);
    assert.throws(() => wrap({ id: 'bad', child: {}, reactive: null }), /reactive/);
    assert.throws(() => createRunner(wrap({ id: 'bad', child: {} })), /Invalid node/);
    assert.throws(() => createRunner(wrap({ id: 'same', child: condition({ id: 'same', test: () => true }) })), /Duplicate/);
  }
  const cycle = { type: 'inverter', id: 'cycle' }; cycle.child = cycle;
  assert.throws(() => createRunner(cycle), /Cyclic/);
});
