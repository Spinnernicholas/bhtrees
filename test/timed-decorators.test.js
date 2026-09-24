import test from 'node:test';
import assert from 'node:assert/strict';
import { action, condition, sequence, selector, repeat, delay, timeout, cooldown,
  createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

function fakeClock() {
  let now = 0, serial = 0;
  const timers = new Map(), callbacks = [];
  return {
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, due: now + ms }); callbacks.push(fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now && timers.delete(id)) timer.fn(); },
    fireLate() { for (const fn of callbacks) fn(); },
    get size() { return timers.size; }
  };
}
const leaf = () => action({ id: 'leaf', tick: c => c.success(c.input) });

test('delay uses elapsed clock time, preserves input/output, and queues through pause', () => {
  const clock = fakeClock(), value = { value: 42 };
  const runner = createRunner(delay({ id: 'delay', ms: 10, child: leaf() }), { clock, input: value });
  assert.equal(runner.tick().frames[0].waitingOn, 'timer');
  for (let i = 0; i < 10; i++) runner.tick();
  assert.equal(clock.size, 1);
  clock.advance(9); assert.equal(runner.tick().frames.length, 1);
  runner.pause(); clock.advance(1);
  assert.equal(runner.tick().status, RUNNING);
  runner.continue();
  assert.equal(runner.tick().output, value); assert.equal(clock.size, 0);
});

test('delay cancellation and reactive interruption remove timer without starting child', () => {
  for (const cancel of [true, false]) {
    let allowed = true;
    const clock = fakeClock();
    const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
      { node: condition({ id: 'guard', test: () => allowed }) },
      { node: delay({ id: 'delay', ms: 10, child: action({ id: 'never', tick: () => assert.fail('No execution') }) }) }
    ] }), { clock });
    runner.tick(); allowed = false;
    assert.equal(cancel ? runner.cancel().status : runner.tick().status, cancel ? 'cancelled' : FAILURE);
    assert.equal(clock.size, 0); clock.fireLate();
    assert.equal(runner.tick().frames.length, 0);
  }
});

test('timeout cancels an active nested wait, discards queued resume, and ignores late results', () => {
  const clock = fakeClock(), cleanup = []; let emit;
  const runner = createRunner(timeout({ id: 'timeout', ms: 10, child: sequence({ id: 'branch', steps: [
    { node: action({ id: 'wait', enter: c => c.wait.event(fn => { emit = fn; return () => cleanup.push('dispose'); }, { resume: 'done' }),
      resume: { done: () => assert.fail('Expired work must not resume') }, cancel: (c, reason) => cleanup.push(reason) }) }
  ] }) }), { clock });
  runner.tick(); emit('queued'); runner.pause(); clock.advance(10);
  assert.equal(runner.tick().status, RUNNING);
  const before = runner.snapshot().transitions;
  assert.equal(runner.step().status, FAILURE);
  assert.equal(runner.snapshot().transitions, before + 1);
  assert.deepEqual(cleanup, ['dispose', 'timeout']);
  emit('late'); clock.fireLate();
  assert.equal(runner.snapshot().queuedResumes, 0); assert.equal(clock.size, 0);
});

test('timeout preserves a result already processed by the engine before expiry', () => {
  const clock = fakeClock();
  const runner = createRunner(timeout({ id: 'timeout', ms: 5, child: leaf() }), { clock, input: 42 });
  runner.step(); runner.step(); runner.step(); // Child completes; wrapper result pending.
  clock.advance(5);
  assert.equal(runner.step().output, 42); assert.equal(runner.snapshot().status, SUCCESS);
  assert.equal(clock.size, 0);
});

test('timeout detects expiry while resuming a memory descendant and releases all timers', () => {
  const clock = fakeClock(); let calls = 0;
  const runner = createRunner(timeout({ id: 'timeout', ms: 10, child: action({ id: 'work',
    tick: () => { calls++; return RUNNING; }
  }) }), { clock });
  runner.tick(); runner.tick(); assert.equal(calls, 2);
  clock.advance(10); assert.equal(runner.tick().status, FAILURE); assert.equal(calls, 2);
  assert.equal(clock.size, 0);
});

test('nested expired timeouts choose the outermost and clear inner delay resources', () => {
  const clock = fakeClock();
  const runner = createRunner(timeout({ id: 'outer', ms: 5, child: timeout({ id: 'inner', ms: 5,
    child: delay({ id: 'delay', ms: 20, child: leaf() }) }) }), { clock });
  runner.tick(); assert.equal(clock.size, 3);
  clock.advance(5); assert.equal(runner.tick().status, FAILURE);
  assert.equal(clock.size, 0);
});

test('zero durations have explicit behavior and invalid durations fail validation', () => {
  const clock = fakeClock();
  for (const wrap of [delay, timeout, cooldown]) {
    for (const ms of [-1, NaN, Infinity, undefined, '10']) {
      assert.throws(() => wrap({ id: 'bad', ms, child: leaf() }), /finite and nonnegative/);
    }
    const result = createRunner(wrap({ id: 'zero', ms: 0, child: action({ id: 'child', tick() {
      if (wrap === timeout) assert.fail('Zero timeout must not start its child');
      return SUCCESS;
    } }) }), { clock }).tick();
    assert.equal(result.status, wrap === timeout ? FAILURE : SUCCESS);
  }
  assert.equal(clock.size, 0);
});

test('cooldown is runner-local, survives reentry, and allows fallback while blocked', () => {
  const clock = fakeClock(); let calls = 0;
  const cooled = cooldown({ id: 'cooldown', ms: 10, child: action({ id: 'work', tick: c => c.success(++calls) }) });
  const tree = repeat({ id: 'repeat', times: Infinity, child: selector({ id: 'choice', steps: [
    { node: cooled }, { node: action({ id: 'fallback', tick: () => SUCCESS }) }
  ] }) });
  const a = createRunner(tree, { clock }), b = createRunner(tree, { clock });
  a.tick(); a.tick(); assert.equal(calls, 1);
  b.tick(); assert.equal(calls, 2); assert.equal(clock.size, 2);
  clock.advance(10); a.tick(); assert.equal(calls, 3);
  a.cancel(); b.cancel(); assert.equal(clock.size, 0);
});

test('cooldown starts after either child result, preserves output, and clears on terminal root', () => {
  for (const status of [SUCCESS, FAILURE]) {
    const clock = fakeClock();
    const result = createRunner(cooldown({ id: 'cooldown', ms: 10, child: action({ id: 'child',
      tick: () => ({ status, output: 42 }) }) }), { clock }).tick();
    assert.equal(result.status, status); assert.equal(result.output, 42); assert.equal(clock.size, 0);
  }
});

test('cooldown does not block a retained running child or start on interruption', () => {
  const clock = fakeClock(); let priority = false, calls = 0;
  const runner = createRunner(selector({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'priority', tick: () => priority ? RUNNING : FAILURE }) },
    { node: cooldown({ id: 'cooldown', ms: 10, child: action({ id: 'work', tick: () => { calls++; return RUNNING; } }) }) }
  ] }), { clock });
  runner.tick(); runner.tick(); assert.equal(calls, 2);
  priority = true; runner.tick(); priority = false; runner.tick();
  assert.equal(calls, 3); assert.equal(clock.size, 0);
});

test('timed wrappers preserve errors and cleanup failures still cancel children', () => {
  for (const wrap of [delay, timeout, cooldown]) {
    const clock = fakeClock(), error = new Error('child failed');
    const runner = createRunner(wrap({ id: 'timed', ms: 1, child: action({ id: 'work', tick: () => { throw error; } }) }), { clock });
    runner.tick(); if (wrap === delay) { clock.advance(1); runner.tick(); }
    assert.equal(runner.snapshot().status, 'errored'); assert.equal(runner.snapshot().error, error);
    assert.equal(clock.size, 0);
  }
  const clock = fakeClock(); let cancelled = 0;
  const runner = createRunner(timeout({ id: 'timeout', ms: 1, child: action({ id: 'work',
    enter: c => c.wait.event(() => () => { throw new Error('dispose failed'); }, { resume: 'done' }),
    resume: { done: () => SUCCESS }, cancel: () => { cancelled++; }
  }) }), { clock });
  runner.tick(); clock.advance(1);
  assert.equal(runner.tick().status, 'errored'); assert.equal(cancelled, 1); assert.equal(clock.size, 0);
});
