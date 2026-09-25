import test from 'node:test';
import assert from 'node:assert/strict';
import { action, timeout, parallel, createRunner, createDebugger } from '../dist/index.js';

test('resume breakpoints preserve queued callbacks and coexist with entry breakpoints', () => {
  let token, calls = 0;
  const debug = createDebugger(createRunner(action({ id: 'a', enter(c) {
    token = c.wait.callback({ resume: 'done' }); return token.wait;
  }, resume: { done(c, value) { calls++; return c.success(value); } } })));
  for (const kind of ['entry', 'resume']) debug.command({ type: 'setBreakpoint', nodeId: 'a', kind });
  debug.command({ type: 'tick' }); assert.equal(debug.snapshot().breakpointHit.kind, 'entry');
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' }); token.resolve(42);
  const transitions = debug.snapshot().runner.transitions;
  debug.command({ type: 'tick' });
  assert.equal(calls, 0); assert.equal(debug.snapshot().runner.queuedResumes, 1);
  assert.equal(debug.snapshot().runner.transitions, transitions);
  assert.equal(debug.snapshot().breakpointHit.kind, 'resume'); assert.equal(debug.snapshot().breakpointHit.handler, 'done');
  debug.command({ type: 'removeBreakpoint', nodeId: 'a' }); assert.equal(debug.snapshot().breakpoints.length, 1);
  debug.command({ type: 'stepInto' }); assert.equal(calls, 1); assert.equal(debug.snapshot().runner.output, 42);
});

test('each new wait on the same activation can hit and conditions use captured activation input', () => {
  const tokens = [];
  function wait(c) { const token = c.wait.callback({ resume: 'again' }); tokens.push(token); return token.wait; }
  const debug = createDebugger(createRunner(action({ id: 'a', enter: wait, resume: {
    again(c) { c.local.count = (c.local.count ?? 0) + 1; return c.local.count === 2 ? c.success() : wait(c); }
  } }), { input: { debug: true } }));
  debug.command({ type: 'setBreakpoint', nodeId: 'a', kind: 'resume', inputPath: ['debug'], equals: true });
  debug.command({ type: 'tick' }); tokens[0].resolve(); debug.command({ type: 'tick' });
  const activation = debug.snapshot().breakpointHit.activationId;
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  tokens[1].resolve(); debug.command({ type: 'tick' });
  assert.equal(debug.snapshot().breakpointHit.activationId, activation);
  debug.command({ type: 'stepOver' }); assert.equal(debug.snapshot().runner.status, 'SUCCESS');
});

test('poll results and rejections stop before continuation/error processing', () => {
  let reject;
  const debug = createDebugger(createRunner(action({ id: 'poll', enter: c => c.wait.poll(() => 'ready', { resume: 'next' }),
    resume: { next(c) { const token = c.wait.callback({ resume: 'next' }); reject = token.reject; return token.wait; } }
  })));
  debug.command({ type: 'setBreakpoint', nodeId: 'poll', kind: 'resume' }); debug.command({ type: 'tick' });
  assert.equal(debug.snapshot().breakpointHit.kind, 'resume');
  debug.command({ type: 'stepInto' }); reject(new Error('failed'));
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  assert.equal(debug.snapshot().runner.status, 'RUNNING'); assert.equal(debug.snapshot().breakpointHit.handler, null);
  debug.command({ type: 'stepInto' }); assert.equal(debug.snapshot().runner.status, 'errored');
  assert.equal(debug.snapshot().runner.error.message, 'failed');
});

test('expired timeout wins over a held resume and cancellation discards queued work', () => {
  for (const cancel of [false, true]) {
    let token, expire, resumed = 0;
    const debug = createDebugger(createRunner(timeout({ id: 'timeout', ms: 10, child: action({ id: 'a', enter(c) {
      token = c.wait.callback({ resume: 'done' }); return token.wait;
    }, resume: { done(c) { resumed++; return c.success(); } } }) }), {
      clock: { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} }
    }));
    debug.command({ type: 'setBreakpoint', nodeId: 'a', kind: 'resume' }); debug.command({ type: 'tick' });
    token.resolve(); debug.command({ type: 'tick' }); assert.equal(debug.snapshot().runner.queuedResumes, 1);
    if (cancel) debug.command({ type: 'cancel' });
    else { expire(); debug.command({ type: 'continue' }); debug.command({ type: 'tick' }); }
    assert.equal(resumed, 0); assert.equal(debug.snapshot().runner.queuedResumes, 0);
    assert.equal(debug.snapshot().runner.status, cancel ? 'cancelled' : 'FAILURE');
  }
});

test('resume observers receive values, isolate errors and release subscriptions', () => {
  const errors = []; let value;
  const runner = createRunner(action({ id: 'a', enter: c => c.wait.poll(() => 7, { resume: 'done' }),
    resume: { done: c => c.success() } }), { onEventError: error => errors.push(error) });
  runner.beforeResume(() => { throw Error('observer'); });
  const off = runner.beforeResume(boundary => { value = boundary.value; return true; });
  runner.tick(); assert.equal(value, 7); assert.equal(errors.length, 1); assert.equal(runner.snapshot().paused, true);
  off(); runner.step(); assert.equal(runner.snapshot().status, 'SUCCESS');
});

test('resume pause preserves parallel traversal and queued promise completions', async () => {
  let resolve; const calls = [];
  const promise = new Promise(done => { resolve = done; });
  const debug = createDebugger(createRunner(parallel({ id: 'p', successThreshold: 2, failureThreshold: 1, steps: [
    { node: action({ id: 'wait', enter: c => c.wait.promise(promise, { resume: 'done' }), resume: {
      done(c) { calls.push('resume'); return c.success(); }
    } }) },
    { node: action({ id: 'other', tick(c) { calls.push('other'); return c.success(); } }) }
  ] })));
  debug.command({ type: 'setBreakpoint', nodeId: 'wait', kind: 'resume' }); debug.command({ type: 'tick' });
  resolve(1); await Promise.resolve(); debug.command({ type: 'tick' });
  assert.deepEqual(calls, ['other']); assert.equal(debug.snapshot().runner.queuedResumes, 1);
  debug.command({ type: 'stepInto' }); assert.deepEqual(calls, ['other', 'resume']);
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  assert.equal(debug.snapshot().runner.status, 'SUCCESS');
});
