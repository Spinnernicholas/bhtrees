import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('data flows down, between siblings, and back up in isolated runners', () => {
  const tree = sequence({ id: 'root', steps: [
    { node: action({ id: 'double', enter: c => c.success(c.input * 2) }), save: 'double' },
    { node: action({ id: 'increment', enter: c => c.success(c.input + 1) }), input: s => s.vars.double }
  ] });
  const first = createRunner(tree, { input: 3 });
  const second = createRunner(tree, { input: 9 });
  assert.equal(first.tick().output, 7);
  assert.equal(second.tick().output, 19);
  assert.equal(first.tick().status, SUCCESS);
});

test('promise completion queues and only resumes during execution', async () => {
  const pending = deferred();
  let entered = 0;
  const runner = createRunner(action({ id: 'async',
    enter(c) { entered++; c.local.count = 3; return c.wait.promise(pending.promise, { resolve: 'done' }); },
    resume: { done: (c, value) => c.success(value + c.local.count) }
  }));
  assert.equal(runner.tick().status, RUNNING);
  runner.pause();
  pending.resolve(4);
  await Promise.resolve();
  assert.equal(runner.tick().status, RUNNING);
  assert.equal(runner.snapshot().queuedResumes, 1);
  runner.continue();
  assert.equal(runner.tick().output, 7);
  assert.equal(entered, 1);
});

test('cancellation cleans up once and ignores late completion', async () => {
  const pending = deferred();
  let cancelled = 0;
  const runner = createRunner(action({ id: 'async',
    enter: c => c.wait.promise(pending.promise, { resolve: 'done' }),
    resume: { done: c => c.success() }, cancel() { cancelled++; }
  }));
  runner.tick(); runner.cancel(); runner.cancel();
  pending.resolve(); await Promise.resolve();
  assert.equal(cancelled, 1);
  assert.equal(runner.tick().status, 'cancelled');
  assert.equal(runner.snapshot().queuedResumes, 0);
});

test('step executes one boundary and tick respects pause', () => {
  let calls = 0;
  const runner = createRunner(action({ id: 'one', enter: c => { calls++; return c.success(); } }));
  assert.equal(runner.step().frames[0].phase, 'enter');
  runner.tick();
  assert.equal(calls, 0);
  assert.equal(runner.step().status, SUCCESS);
  assert.equal(calls, 1);
});

test('tick actions return RUNNING once per drive and retain local state', () => {
  let calls = 0;
  const runner = createRunner(action({ id: 'count', tick(c) {
    calls++;
    c.local.count = (c.local.count ?? 0) + 1;
    return c.local.count < 3 ? RUNNING : c.success(c.local.count);
  } }));
  assert.equal(runner.tick().frames[0].phase, 'running');
  assert.equal(calls, 1);
  runner.pause(); runner.tick();
  assert.equal(calls, 1);
  const before = runner.snapshot().transitions;
  assert.equal(runner.step().transitions, before + 1);
  assert.equal(calls, 2);
  assert.equal(runner.snapshot().paused, true);
  runner.continue();
  assert.equal(runner.tick().output, 3);
  runner.tick();
  assert.equal(calls, 3);
});

test('tick actions propagate bare success and failure through sequences', () => {
  const runner = createRunner(sequence({ id: 'root', steps: [
    { node: action({ id: 'yes', tick: () => SUCCESS }) },
    { node: action({ id: 'no', tick: () => FAILURE }) },
    { node: action({ id: 'never', tick() { assert.fail('Must not run'); } }) }
  ] }));
  assert.equal(runner.tick().status, FAILURE);
});

test('failure short circuits a sequence with its output', () => {
  const runner = createRunner(sequence({ id: 'root', steps: [
    { node: action({ id: 'fail', enter: c => c.failure('reason') }) },
    { node: action({ id: 'never', enter() { assert.fail('must not run'); } }) }
  ] }));
  assert.equal(runner.tick().status, FAILURE);
  assert.equal(runner.snapshot().output, 'reason');
});

test('exceptions remain errors and cleanup failures preserve the original cause', () => {
  const cause = new Error('original');
  const runner = createRunner(action({ id: 'bad', enter() { throw cause; }, cancel() { throw new Error('cleanup'); } }));
  const result = runner.tick();
  assert.equal(result.status, 'errored');
  assert.equal(result.error.errors[0], cause);
});

test('promise rejection uses a named handler', async () => {
  const pending = deferred();
  const runner = createRunner(action({ id: 'reject',
    enter: c => c.wait.promise(pending.promise, { resolve: 'yes', reject: 'no' }),
    resume: { yes: c => c.success(), no: (c, error) => c.failure(error.message) }
  }));
  runner.tick(); pending.reject(new Error('offline')); await Promise.resolve();
  assert.equal(runner.tick().output, 'offline');
  assert.equal(runner.snapshot().status, FAILURE);
});

test('step budget bounds execution and terminal roots do not restart', () => {
  let calls = 0;
  const runner = createRunner(action({ id: 'one', enter: c => { calls++; return c.success(); } }), { maxStepsPerTick: 1 });
  assert.equal(runner.tick().status, RUNNING);
  assert.equal(calls, 0);
  assert.equal(runner.tick().status, SUCCESS);
  runner.tick(); assert.equal(calls, 1);
});
