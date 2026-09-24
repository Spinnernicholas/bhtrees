import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, createRunner, SUCCESS, FAILURE, RUNNING } from '../dist/index.js';

test('callback token settlements enqueue once and run the named handler on a later drive', () => {
  let token, resumed = 0;
  const runner = createRunner(action({ id: 'wait', enter(c) {
    token = c.wait.callback({ resume: 'done' }); return token.wait;
  }, resume: { done(c, value) { resumed++; return c.success(value); } } }));
  runner.tick(); assert.equal(runner.snapshot().frames[0].waitingOn, 'callback');
  assert.ok(Object.isFrozen(token) && Object.isFrozen(token.wait));
  assert.equal(token.resolve(42), true); assert.equal(token.resolve(43), false); assert.equal(token.reject('late'), false);
  assert.equal(resumed, 0); assert.equal(runner.snapshot().queuedResumes, 1);
  assert.equal(runner.tick().output, 42); assert.equal(resumed, 1);
});

test('synchronous callbacks before registration preserve their value and rejection', () => {
  for (const rejected of [false, true]) {
    const value = { result: true };
    const runner = createRunner(action({ id: 'sync', enter(c) {
      const token = c.wait.callback({ resolve: 'done', reject: 'failed' });
      assert.equal(rejected ? token.reject(value) : token.resolve(value), true);
      return token.wait;
    }, resume: { done: (c, result) => c.success(result), failed: (c, result) => c.failure(result) } }));
    const state = runner.tick();
    assert.equal(state.status, rejected ? FAILURE : SUCCESS); assert.equal(state.output, value);
  }
});

test('unhandled callback rejection becomes an execution error without promise rejection', () => {
  let token; const error = new Error('callback error');
  const runner = createRunner(action({ id: 'wait', enter(c) {
    token = c.wait.callback({ resume: 'done' }); return token.wait;
  }, resume: { done: () => SUCCESS } }));
  runner.tick(); token.reject(error);
  assert.equal(runner.tick().status, 'errored'); assert.equal(runner.snapshot().error, error);
});

test('pause retains queued callbacks and cancellation invalidates tokens', () => {
  let token, stopped = 0;
  const runner = createRunner(action({ id: 'wait', enter(c) {
    token = c.wait.callback({ resume: 'done' }); return token.wait;
  }, resume: { done: () => assert.fail('Cancelled work resumed') }, cancel: () => { stopped++; } }));
  runner.tick(); runner.pause(); token.resolve(1);
  assert.equal(runner.tick().status, RUNNING); assert.equal(runner.snapshot().queuedResumes, 1);
  runner.cancel(); assert.equal(stopped, 1); assert.equal(token.resolve(2), false);
  assert.equal(runner.snapshot().queuedResumes, 0);
  let pending;
  const other = createRunner(action({ id: 'other', enter(c) {
    pending = c.wait.callback({ resume: 'done' }); return pending.wait;
  }, resume: { done: () => SUCCESS } }));
  other.tick(); other.cancel(); assert.equal(pending.resolve(), false); assert.equal(pending.reject(), false);
});

test('callback waits compose in nested any/all and dispose losing registered tokens', () => {
  let first, second, loser;
  const runner = createRunner(action({ id: 'group', enter(c) {
    first = c.wait.callback(); second = c.wait.callback(); loser = c.wait.callback();
    return c.wait.any([c.wait.all([first.wait, second.wait]), loser.wait], { resume: 'done' });
  }, resume: { done: (c, value) => c.success(value) } }));
  runner.tick(); second.resolve('second'); first.resolve('first');
  assert.deepEqual(runner.tick().output, { index: 0, value: ['first', 'second'] });
  assert.equal(loser.resolve('late'), false);
});

test('callback group rejection fails fast and disposes other tokens', () => {
  let a, b;
  const runner = createRunner(action({ id: 'group', enter(c) {
    a = c.wait.callback(); b = c.wait.callback();
    return c.wait.all([a.wait, b.wait], { resume: 'done', reject: 'failed' });
  }, resume: { done: () => SUCCESS, failed: (c, value) => c.failure(value) } }));
  runner.tick(); a.reject('failed'); assert.equal(runner.tick().output, 'failed');
  assert.equal(b.resolve(), false);
});

test('tokens cannot be reused across activations and forged descriptors are rejected', () => {
  let token;
  const tree = action({ id: 'wait', enter(c) { token ??= c.wait.callback({ resume: 'done' }); return token.wait; },
    resume: { done: () => SUCCESS } });
  const a = createRunner(tree), b = createRunner(tree);
  a.tick(); assert.equal(b.tick().status, 'errored');
  assert.match(b.snapshot().error.message, /only be registered once/);
  token.resolve(); assert.equal(a.tick().status, SUCCESS);
  const c = createRunner(tree); assert.equal(c.tick().status, 'errored');
  const fake = createRunner(action({ id: 'fake', enter: () => ({ status: RUNNING, kind: 'callback', resolve: 'done' }), resume: { done: () => SUCCESS } }));
  assert.equal(fake.tick().status, 'errored'); assert.match(fake.snapshot().error.message, /created by wait.callback/);
});

test('reactive preemption invalidates old tokens and reentry creates a fresh handle', () => {
  let pauseWork = false; const tokens = [];
  const runner = createRunner(sequence({ id: 'root', reactive: true, steps: [
    { node: action({ id: 'guard', tick: () => pauseWork ? RUNNING : SUCCESS }) },
    { node: action({ id: 'work', enter(c) {
      const token = c.wait.callback({ resume: 'done' }); tokens.push(token); return token.wait;
    }, resume: { done: () => SUCCESS } }) }
  ] }));
  runner.tick(); pauseWork = true; runner.tick();
  assert.equal(tokens[0].resolve('late'), false);
  pauseWork = false; runner.tick(); assert.equal(tokens.length, 2);
  assert.equal(tokens[1].resolve('fresh'), true); assert.equal(runner.tick().status, SUCCESS);
});
