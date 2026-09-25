import test from 'node:test';
import assert from 'node:assert/strict';
import { action, createRunner, createRunnerScheduler, RUNNING, SUCCESS } from '../dist/index.js';

function fakeClock() {
  let serial = 0;
  const timers = new Map(), history = [];
  return {
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, fn); history.push(fn); assert.ok(ms > 0); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire() { for (const [id, fn] of [...timers]) if (timers.delete(id)) fn(); },
    late() { for (const fn of [...history]) fn(); },
    get size() { return timers.size; }
  };
}

test('scheduler drives asynchronously once per timer and stops at terminal results', () => {
  const clock = fakeClock(), calls = [];
  let count = 0;
  const runner = createRunner(action({ id: 'a', tick: () => ++count === 2 ? SUCCESS : RUNNING }));
  const scheduler = createRunnerScheduler(runner, { clock, beforeTick: () => calls.push('before'), onTick: s => calls.push(s.status) });
  scheduler.start(); scheduler.start();
  assert.equal(count, 0); assert.equal(clock.size, 1);
  clock.fire(); assert.equal(count, 1); assert.equal(clock.size, 1);
  clock.fire(); assert.equal(count, 2); assert.equal(clock.size, 0); assert.equal(scheduler.running, false);
  assert.deepEqual(calls, ['before', RUNNING, 'before', SUCCESS]);
  scheduler.start(); assert.equal(clock.size, 0);
});

test('paused runners retain async completions until continued', () => {
  const clock = fakeClock(); let token, hooks = 0;
  const runner = createRunner(action({ id: 'a', enter: c => {
    token = c.wait.callback({ resume: 'done' }); return token.wait;
  }, resume: { done: c => c.success(42) } }));
  const scheduler = createRunnerScheduler(runner, { clock, beforeTick: () => hooks++ });
  scheduler.start(); clock.fire(); runner.pause(); token.resolve();
  clock.fire(); clock.fire();
  assert.equal(hooks, 1); assert.equal(runner.snapshot().queuedResumes, 1);
  runner.continue(); clock.fire();
  assert.equal(runner.snapshot().output, 42); assert.equal(clock.size, 0);
});

test('stop/restart invalidates stale callbacks and disposal does not cancel external work', () => {
  const clock = fakeClock(); let ticks = 0, cancelled = 0;
  const runner = createRunner(action({ id: 'a', tick: () => { ticks++; return RUNNING; }, cancel: () => cancelled++ }));
  const scheduler = createRunnerScheduler(runner, { clock });
  scheduler.start(); scheduler.stop(); clock.late(); assert.equal(ticks, 0);
  scheduler.start(); clock.fire(); assert.equal(ticks, 1);
  scheduler.dispose(); scheduler.dispose(); clock.late();
  assert.equal(ticks, 1); assert.equal(cancelled, 0); assert.equal(clock.size, 0);
  assert.throws(() => scheduler.start(), /disposed/);
});

test('hooks can stop or restart scheduling without duplicate timers', () => {
  const clock = fakeClock(); let ticks = 0, restart = true;
  const runner = createRunner(action({ id: 'a', tick: () => { ticks++; return RUNNING; } }));
  const scheduler = createRunnerScheduler(runner, { clock, beforeTick() {
    if (restart) { restart = false; scheduler.stop(); scheduler.start(); }
  }, onTick() { scheduler.dispose(); } });
  scheduler.start(); clock.fire(); assert.equal(ticks, 0); assert.equal(clock.size, 1);
  clock.fire(); assert.equal(ticks, 1); assert.equal(clock.size, 0);
});

test('runner errors terminate drives and hook errors stop and report once', () => {
  for (const hook of [false, true]) {
    const clock = fakeClock(), errors = [], boom = new Error('boom');
    const runner = createRunner(action({ id: 'a', tick: () => { if (!hook) throw boom; return RUNNING; } }));
    const scheduler = createRunnerScheduler(runner, { clock, onTick() { if (hook) throw boom; }, onError: e => errors.push(e) });
    scheduler.start(); clock.fire();
    assert.equal(scheduler.running, false); assert.equal(clock.size, 0);
    if (hook) assert.deepEqual(errors, [boom]);
    else assert.equal(runner.snapshot().status, 'errored');
  }
});

test('rejects invalid intervals and releases scheduling state when timer setup throws', () => {
  const runner = createRunner(action({ id: 'a', tick: () => RUNNING }));
  for (const intervalMs of [0, -1, NaN, Infinity]) assert.throws(() => createRunnerScheduler(runner, { intervalMs }), /intervalMs/);
  const scheduler = createRunnerScheduler(runner, { clock: { setTimeout() { throw Error('timer'); }, clearTimeout() {} } });
  assert.throws(() => scheduler.start(), /timer/); assert.equal(scheduler.running, false);
});
