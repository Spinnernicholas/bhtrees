import test from 'node:test';
import assert from 'node:assert/strict';
import { action, condition, sequence, parallel, repeat, timeout, cooldown, createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

const pair = (steps, options = {}) => parallel({ id: 'parallel', steps, successThreshold: steps.length, failureThreshold: 1, ...options });

test('parallel advances every running branch once per tick and retains independent activations', () => {
  const shared = action({ id: 'shared', tick(c) {
    c.local.count = (c.local.count ?? 0) + 1;
    return c.local.count === c.input ? c.success(c.input) : RUNNING;
  } });
  const runner = createRunner(pair([{ node: shared, input: () => 2 }, { node: shared, input: () => 3 }]));
  runner.tick();
  const frames = runner.snapshot().frames.filter(f => f.nodeId === 'shared');
  assert.equal(frames.length, 2); assert.notEqual(frames[0].activationId, frames[1].activationId);
  assert.deepEqual(frames.map(f => f.parentChildIndex), [0, 1]);
  assert.deepEqual(frames.map(f => f.local.count), [1, 1]);
  const second = runner.tick(); assert.equal(second.status, RUNNING);
  assert.deepEqual(second.frames[0].parallelResults, [{ status: SUCCESS, output: 2 }, undefined]);
  const final = runner.tick(); assert.equal(final.status, SUCCESS);
  assert.deepEqual(final.output, [{ status: SUCCESS, output: 2 }, { status: SUCCESS, output: 3 }]);
});

test('threshold short circuit cancels unfinished work before reducer and skips unvisited children', () => {
  const log = [];
  const runner = createRunner(pair([
    { node: action({ id: 'running', tick: () => RUNNING, cancel: (c, reason) => log.push(reason) }) },
    { node: action({ id: 'win', tick: c => c.success('win') }) },
    { node: action({ id: 'unvisited', tick: () => assert.fail('Threshold already met') }) }
  ], { successThreshold: 1, output: (results, status) => {
    assert.deepEqual(log, ['parallel-complete']); assert.equal(status, SUCCESS);
    assert.ok(Object.isFrozen(results)); assert.ok(Object.isFrozen(results[1]));
    return results.map(result => result?.output);
  } }));
  assert.deepEqual(runner.tick().output, [undefined, 'win', undefined]);
});

test('failed threshold preserves failure outputs and never converts exceptions', () => {
  const error = new Error('broken');
  const runner = createRunner(pair([
    { node: action({ id: 'failed', tick: c => c.failure(42) }) },
    { node: action({ id: 'unused', tick: () => assert.fail('Short circuit') }) }
  ]));
  assert.equal(runner.tick().status, FAILURE); assert.equal(runner.snapshot().output[0].output, 42);
  const broken = createRunner(pair([{ node: action({ id: 'throws', tick: () => { throw error; } }) }]));
  assert.equal(broken.tick().status, 'errored'); assert.equal(broken.snapshot().error, error);
});

test('all waiting branches register, pause queues completions, and declaration order breaks races', () => {
  const emitters = [], disposed = [];
  const steps = [0, 1].map(index => ({ node: action({ id: `wait-${index}`,
    enter: c => c.wait.event(fn => { emitters[index] = fn; return () => disposed.push(index); }, { resume: 'done' }),
    resume: { done: (c, value) => c.success(value) }
  }) }));
  const runner = createRunner(pair(steps, { successThreshold: 1 }));
  runner.tick(); assert.equal(emitters.length, 2);
  runner.pause(); emitters[1]('second'); emitters[0]('first');
  assert.equal(runner.tick().queuedResumes, 2);
  runner.continue();
  assert.deepEqual(runner.tick().output, [{ status: SUCCESS, output: 'first' }, undefined]);
  assert.deepEqual(disposed, [0, 1]);
  emitters[1]('late'); assert.equal(runner.snapshot().queuedResumes, 0);
});

test('branch input scopes are isolated and reducer explicitly combines outputs', () => {
  const shared = sequence({ id: 'branch', steps: [
    { node: action({ id: 'leaf', enter: c => c.success(c.input) }), save: 'private' }
  ], output: scope => scope.vars.private });
  const runner = createRunner(pair([2, 3].map(value => ({ node: shared, input: scope => {
    assert.equal(scope.last, undefined); assert.deepEqual(Object.keys(scope.vars), []);
    assert.ok(Object.isFrozen(scope.vars)); return value + scope.input;
  } })), { output: results => results.reduce((sum, result) => sum + result.output, 0) }), { input: 10 });
  assert.equal(runner.tick().output, 25);
});

test('nested parallel branches and retry/repeat yields do not starve siblings', () => {
  let calls = 0;
  const runner = createRunner(pair([
    { node: parallel({ id: 'inner', successThreshold: 2, failureThreshold: 1, steps: [
      { node: repeat({ id: 'repeat', times: 2, child: condition({ id: 'yes', test: () => true }) }) },
      { node: action({ id: 'inner-work', tick: () => SUCCESS }) }
    ] }) },
    { node: action({ id: 'outer-work', tick: () => { calls++; return SUCCESS; } }) }
  ]));
  assert.equal(runner.tick().status, RUNNING); assert.equal(calls, 1);
  assert.equal(runner.tick().status, SUCCESS); assert.equal(calls, 1);
});

test('single-step budgets preserve branch position and completed branches across drives', () => {
  for (const manual of [true, false]) {
    const visits = [];
    const runner = createRunner(pair([0, 1, 2].map(i => ({ node: action({ id: `a${i}`, tick(c) {
      visits.push(i); c.local.count = (c.local.count ?? 0) + 1;
      return c.local.count === 2 ? SUCCESS : RUNNING;
    } }) }))), { maxStepsPerTick: 1 });
    for (let i = 0; i < 100 && runner.snapshot().status !== SUCCESS; i++) {
      const before = runner.snapshot().transitions;
      const state = manual ? runner.step() : runner.tick();
      assert.ok(state.transitions - before <= 1);
    }
    assert.equal(runner.snapshot().status, SUCCESS);
    assert.deepEqual(visits, [0, 1, 2, 0, 1, 2]);
  }
});

test('reactive parent preempts all parallel branches and cleanup errors do not skip siblings', () => {
  for (const throws of [false, true]) {
    let allowed = true; const cancelled = [];
    const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
      { node: condition({ id: 'guard', test: () => allowed }) },
      { node: pair([0, 1].map(i => ({ node: action({ id: `a${i}`, tick: () => RUNNING, cancel() {
        cancelled.push(i); if (throws && i === 0) throw new Error('cleanup');
      } }) }))) }
    ] }));
    runner.tick(); allowed = false;
    assert.equal(runner.tick().status, throws ? 'errored' : FAILURE);
    assert.deepEqual(cancelled, [0, 1]); assert.equal(runner.snapshot().frames.length, 0);
  }
});

test('parallel honors inherited reactive guards without restarting completed branches', () => {
  let checks = 0, finished = 0;
  const runner = createRunner(pair([
    { node: sequence({ id: 'branch', steps: [
      { node: condition({ id: 'guard', test: () => { checks++; return true; } }) },
      { node: action({ id: 'running', tick: () => RUNNING }) }
    ] }) },
    { node: action({ id: 'finished', tick: () => { finished++; return SUCCESS; } }) }
  ], { reactive: true }));
  runner.tick(); runner.tick(); assert.equal(checks, 2); assert.equal(finished, 1);
  runner.cancel();
});

test('parallel validates thresholds, nonempty children, and disallows shared save bindings', () => {
  const steps = [0, 1].map(i => ({ node: condition({ id: `${i}`, test: () => true }) }));
  assert.throws(() => pair([]), /nonempty/);
  for (const threshold of [0, -1, 1.5, NaN, Infinity, 3, undefined]) {
    assert.throws(() => pair(steps, { successThreshold: threshold }), /thresholds/);
    assert.throws(() => pair(steps, { failureThreshold: threshold }), /thresholds/);
  }
  assert.throws(() => pair(steps, { successThreshold: 2, failureThreshold: 2 }), /guarantee/);
  assert.throws(() => pair([{ ...steps[0], save: 'value' }]), /reducer/);
});

test('shared cooldown completion refreshes one runner-local timer without leaking', () => {
  const timers = new Map(); let serial = 0;
  const clock = { setTimeout(fn) { timers.set(++serial, fn); return serial; }, clearTimeout(id) { timers.delete(id); } };
  const shared = cooldown({ id: 'cooldown', ms: 10, child: action({ id: 'work', tick(c) {
    c.local.called = (c.local.called ?? 0) + 1; return c.local.called === 1 ? RUNNING : SUCCESS;
  } }) });
  const runner = createRunner(pair([{ node: shared }, { node: shared }]), { clock });
  runner.tick(); assert.equal(runner.tick().status, SUCCESS); assert.equal(timers.size, 0);
});

test('timeouts in one branch do not stop visits to other branches', () => {
  let expire; let calls = 0;
  const clock = { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} };
  const runner = createRunner(pair([
    { node: timeout({ id: 'timeout', ms: 10, child: action({ id: 'wait', tick: () => RUNNING }) }) },
    { node: action({ id: 'other', tick: () => { calls++; return RUNNING; } }) }
  ], { successThreshold: 1, failureThreshold: 2 }), { clock });
  runner.tick(); expire(); runner.tick();
  assert.equal(calls, 2); assert.equal(runner.snapshot().frames[0].parallelResults[0].status, FAILURE);
  runner.cancel();
});
