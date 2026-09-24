import test from 'node:test';
import assert from 'node:assert/strict';
import { action, condition, sequence, selector, retry, repeat, createRunner,
  SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

for (const [wrap, option, terminal] of [[retry, 'attempts', FAILURE], [repeat, 'times', SUCCESS]]) {
  test(`${wrap.name} uses fresh child state, preserves input, yields, and returns final output`, () => {
    let calls = 0;
    const input = { shared: true };
    const tree = wrap({ id: 'loop', [option]: 3, child: action({ id: 'child', tick(c) {
      assert.equal(c.input, input); assert.equal(c.local.called, undefined);
      c.local.called = true;
      return { status: terminal, output: ++calls };
    } }) });
    assert.ok(Object.isFrozen(tree));
    const runner = createRunner(tree, { input });
    for (let i = 1; i <= 3; i++) {
      const state = runner.tick();
      assert.equal(calls, i);
      assert.equal(state.status, i < 3 ? RUNNING : terminal);
      if (i < 3) assert.equal(state.frames[0].completedIterations, i);
      else assert.equal(state.output, 3);
    }
    runner.tick(); assert.equal(calls, 3);
  });

  test(`${wrap.name} retains a running child and counts only finished attempts`, () => {
    let attempts = 0;
    const runner = createRunner(wrap({ id: 'loop', [option]: 2, child: action({ id: 'work', tick(c) {
      if (!c.local.started) { c.local.started = true; attempts++; return RUNNING; }
      return terminal;
    } }) }));
    const first = runner.tick();
    assert.equal(first.frames[0].completedIterations, 0);
    assert.equal(runner.tick().frames[0].completedIterations, 1);
    const second = runner.tick();
    assert.notEqual(second.frames.at(-1).activationId, first.frames.at(-1).activationId);
    assert.equal(runner.tick().status, terminal);
    assert.equal(attempts, 2);
  });

  test(`${wrap.name} isolates concurrent runners and stops early on the opposite status`, () => {
    const status = terminal === SUCCESS ? FAILURE : SUCCESS;
    const tree = wrap({ id: 'loop', [option]: 5, child: action({ id: 'work', enter: c =>
      ({ status: c.input, output: c.input }) }) });
    const early = createRunner(tree, { input: status });
    const continuing = createRunner(tree, { input: terminal });
    assert.equal(early.tick().status, status);
    assert.equal(early.snapshot().output, status);
    assert.equal(continuing.tick().frames[0].completedIterations, 1);
    assert.equal(continuing.tick().frames[0].completedIterations, 2);
  });

  test(`${wrap.name} handles waits, discards old callbacks, and cleans up cancellation`, () => {
    const callbacks = [], cleanup = [];
    const runner = createRunner(wrap({ id: 'loop', [option]: Infinity, child: action({ id: 'work',
      enter: c => c.wait.event(fn => { callbacks.push(fn); return () => cleanup.push('dispose'); }, { resume: 'done' }),
      resume: { done: (c, value) => ({ status: terminal, output: value }) },
      cancel: () => cleanup.push('cancel')
    }) }));
    runner.tick(); callbacks[0]('first'); runner.tick(); runner.tick();
    callbacks[0]('late'); assert.equal(runner.snapshot().queuedResumes, 0);
    callbacks[1]('queued');
    assert.equal(runner.cancel().status, 'cancelled');
    callbacks[1]('late'); runner.tick();
    assert.equal(runner.snapshot().queuedResumes, 0);
    assert.deepEqual(cleanup, ['dispose', 'dispose', 'cancel']);
  });

  test(`${wrap.name} honors one-transition budgets and pause between attempts`, () => {
    for (const manual of [true, false]) {
      let calls = 0;
      const runner = createRunner(wrap({ id: 'loop', [option]: 3, child: action({ id: 'work',
        tick: () => { calls++; return terminal; }
      }) }), { maxStepsPerTick: 1 });
      for (let i = 0; i < 30 && ![SUCCESS, FAILURE].includes(runner.snapshot().status); i++) {
        const before = runner.snapshot().transitions;
        const state = manual ? runner.step() : runner.tick();
        assert.equal(state.transitions, before + 1);
        if (manual) assert.equal(runner.tick().transitions, state.transitions);
      }
      assert.equal(runner.snapshot().status, terminal); assert.equal(calls, 3);
    }
  });

  test(`${wrap.name} allows reactive guards to interrupt an infinite synchronous loop`, () => {
    let allowed = true, calls = 0;
    const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
      { node: condition({ id: 'guard', test: () => allowed }) },
      { node: wrap({ id: 'loop', [option]: Infinity, child: action({ id: 'work',
        tick: () => { calls++; return terminal; }
      }) }) }
    ] }));
    runner.tick(); runner.tick(); assert.equal(calls, 2);
    allowed = false;
    assert.equal(runner.tick().status, FAILURE); assert.equal(calls, 2);
    assert.equal(runner.snapshot().frames.length, 0);
  });

  test(`${wrap.name} propagates errors without another attempt`, () => {
    const error = new Error('boom'); let calls = 0;
    const runner = createRunner(wrap({ id: 'loop', [option]: Infinity, child: action({ id: 'work',
      tick: () => { calls++; throw error; }
    }) }));
    assert.equal(runner.tick().status, 'errored');
    assert.equal(runner.snapshot().error, error); runner.tick(); assert.equal(calls, 1);
  });
}

test('zero repetitions succeed without executing or cancelling a child', () => {
  const runner = createRunner(repeat({ id: 'empty', times: 0, child: action({ id: 'unused',
    tick: () => assert.fail('No execution'), cancel: () => assert.fail('No cancellation')
  }) }));
  assert.equal(runner.tick().status, SUCCESS);
  assert.equal(runner.snapshot().output, undefined);
});

test('loop counts reject invalid and unsafe integers, and require explicit Infinity', () => {
  const child = condition({ id: 'child', test: () => true });
  for (const value of [undefined, null, NaN, -1, -Infinity, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => retry({ id: 'retry', child, attempts: value }), /Retry attempts/);
    assert.throws(() => repeat({ id: 'repeat', child, times: value }), /Repeat times/);
  }
  assert.throws(() => retry({ id: 'retry', child, attempts: 0 }), /Retry attempts/);
  for (const value of [1, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.equal(retry({ id: 'retry', child, attempts: value }).attempts, value);
    assert.equal(repeat({ id: 'repeat', child, times: value }).times, value);
  }
});

test('reactive selector preemption resets a loop count on later reentry', () => {
  let priority = false;
  const runner = createRunner(selector({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'priority', tick: () => priority ? RUNNING : FAILURE }) },
    { node: repeat({ id: 'loop', times: 4, child: condition({ id: 'yes', test: () => true }) }) }
  ] }));
  runner.tick(); runner.tick();
  assert.equal(runner.snapshot().frames.at(-1).completedIterations, 2);
  priority = true; runner.tick(); priority = false; runner.tick();
  assert.equal(runner.snapshot().frames.at(-1).completedIterations, 1);
});
