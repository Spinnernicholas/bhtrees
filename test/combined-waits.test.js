import test from 'node:test';
import assert from 'node:assert/strict';
import { action, createRunner, RUNNING, FAILURE } from '../src/index.js';

const make = enter => createRunner(action({ id: 'wait', enter, resume: {
  done: (ctx, value) => ctx.success(value), failed: (ctx, error) => ctx.failure(error.message)
} }));

test('poll checks once per drive, never while paused, and returns truthy value', () => {
  let calls = 0, ready = false;
  const runner = make(c => c.wait.poll(() => { calls++; return ready && 'ready'; }, { resume: 'done' }));
  runner.tick(); assert.equal(calls, 1);
  runner.tick(); assert.equal(calls, 2);
  runner.pause(); runner.tick(); assert.equal(calls, 2);
  ready = true; assert.equal(runner.step().output, 'ready'); assert.equal(calls, 3);
});

test('any chooses the first notification and releases every listener', () => {
  const emitters = []; let disposed = 0;
  const runner = make(c => c.wait.any([0, 1].map(() => c.wait.event(emit => {
    emitters.push(emit); return () => { disposed++; };
  })), { resume: 'done' }));
  runner.tick(); emitters[1]('second'); emitters[0]('first');
  assert.deepEqual(runner.tick().output, { index: 1, value: 'second' });
  assert.equal(disposed, 2);
  emitters[0]('late'); assert.equal(runner.snapshot().queuedResumes, 0);
});

test('all preserves declaration order despite out-of-order completion', () => {
  const emitters = []; let disposed = 0;
  const runner = make(c => c.wait.all([0, 1].map(() => c.wait.event(emit => {
    emitters.push(emit); return () => { disposed++; };
  })), { resume: 'done' }));
  runner.tick(); emitters[1]('b'); emitters[1]('duplicate');
  assert.equal(runner.tick().status, RUNNING);
  emitters[0]('a'); assert.deepEqual(runner.tick().output, ['a', 'b']);
  assert.equal(disposed, 2);
});

test('all fails fast on promise rejection and cleans up siblings', async () => {
  let disposed = false;
  const runner = make(c => c.wait.all([
    c.wait.event(() => () => { disposed = true; }),
    c.wait.promise(Promise.reject(new Error('offline')))
  ], { resume: 'done', reject: 'failed' }));
  runner.tick(); await Promise.resolve();
  assert.equal(runner.tick().status, FAILURE);
  assert.equal(runner.snapshot().output, 'offline'); assert.equal(disposed, true);
});

test('nested waits work and cancellation releases all registrations', () => {
  let disposed = 0;
  const runner = make(c => c.wait.all([
    c.wait.any([c.wait.poll(() => false), c.wait.event(() => () => { disposed++; })]),
    c.wait.event(() => () => { disposed++; })
  ], { resume: 'done' }));
  runner.tick(); runner.cancel(); runner.cancel(); assert.equal(disposed, 2);
});

test('setup failure rolls back previously acquired resources', () => {
  let disposed = 0;
  const runner = make(c => c.wait.all([
    c.wait.event(() => () => { disposed++; }),
    c.wait.event(() => { throw new Error('setup'); })
  ], { resume: 'done' }));
  assert.equal(runner.tick().status, 'errored'); assert.equal(disposed, 1);
});

test('a synchronous race winner skips later subscriptions', () => {
  let installed = false;
  const runner = make(c => c.wait.any([
    c.wait.event(emit => { emit(1); return () => {}; }),
    c.wait.event(() => { installed = true; return () => {}; })
  ], { resume: 'done' }));
  assert.deepEqual(runner.tick().output, { index: 0, value: 1 }); assert.equal(installed, false);
});

test('empty groups and asynchronous polling are rejected', () => {
  assert.equal(make(c => c.wait.any([], { resume: 'done' })).tick().status, 'errored');
  assert.equal(make(c => c.wait.poll(() => Promise.resolve(true), { resume: 'done' })).tick().status, 'errored');
});
