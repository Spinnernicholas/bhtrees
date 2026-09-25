import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, createRunner, createDebugger, RUNNING } from '../dist/index.js';

test('immediate independent subscriptions and wrapper drives publish shared snapshots', () => {
  const debug = createDebugger(createRunner(action({ id: 'a', tick: () => RUNNING })));
  const a = [], b = [];
  const off = debug.subscribe(s => a.push(s)); debug.subscribe(s => b.push(s));
  assert.equal(a[0].runner.status, 'idle'); assert.equal(a[0], b[0]);
  debug.runner.tick(); assert.equal(a.length, 2); assert.equal(a[1].revision, 1);
  off(); off(); debug.runner.pause(); assert.equal(a.length, 2); assert.equal(b.length, 3);
  debug.dispose(); debug.runner.continue(); assert.equal(b.length, 3);
  assert.equal(debug.runner.snapshot().status, RUNNING);
  assert.equal(debug.command({ type: 'cancel' }).code, 'DISPOSED');
  assert.throws(() => debug.subscribe(() => {}), /disposed/);
});

test('stepInto advances one transition, tick respects pause, and live selection expires', () => {
  const debug = createDebugger(createRunner(sequence({ id: 'root', steps: [
    { node: action({ id: 'a', tick: c => c.success(42) }) }
  ] })));
  assert.equal(debug.command({ type: 'stepInto' }).ok, true);
  assert.equal(debug.snapshot().runner.transitions, 1);
  assert.equal(debug.snapshot().runner.paused, true);
  assert.equal(debug.command({ type: 'tick' }).code, 'INVALID_STATE');
  const activationId = debug.snapshot().runner.frames[0].activationId;
  assert.equal(debug.command({ type: 'select', activationId }).ok, true);
  assert.equal(debug.snapshot().selection.nodeId, 'root');
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  assert.equal(debug.snapshot().runner.status, 'SUCCESS');
  assert.equal(debug.snapshot().selection, null);
  assert.equal(debug.command({ type: 'stepInto' }).code, 'INVALID_STATE');
  assert.equal(debug.command({ type: 'select', activationId }).code, 'INVALID_STATE');
});

test('paused completions are observable with refresh and consumed after continue', () => {
  let token;
  const source = createRunner(action({ id: 'a', enter(c) {
    token = c.wait.callback({ resume: 'done' }); return token.wait;
  }, resume: { done: c => c.success(42) } }));
  const debug = createDebugger(source);
  debug.command({ type: 'tick' }); debug.command({ type: 'pause' }); token.resolve();
  assert.equal(debug.snapshot().runner.queuedResumes, 0);
  debug.refresh(); assert.equal(debug.snapshot().runner.queuedResumes, 1);
  debug.command({ type: 'continue' }); debug.command({ type: 'tick' });
  assert.equal(debug.snapshot().runner.output, 42);
});

test('commands reject malformed input without reading getters or changing execution', () => {
  const debug = createDebugger(createRunner(action({ id: 'a', tick: () => RUNNING })));
  for (const command of [null, [], { type: 'oops' }, { type: 'tick', extra: true }, { type: 'cancel', reason: 1 },
    { type: 'select', activationId: -1 }, { type: 'select' }, { get type() { assert.fail('getter'); } },
    { type: 'tick', [Symbol('x')]: 1 }]) {
    assert.equal(debug.command(command).code, 'INVALID_COMMAND');
  }
  assert.equal(debug.snapshot().revision, 0); assert.equal(debug.runner.snapshot().status, 'idle');
});

test('listener failures and reentrant commands cannot interrupt delivery or execute extra work', () => {
  let ticks = 0; const errors = [], outcomes = [], revisions = [];
  const debug = createDebugger(createRunner(action({ id: 'a', tick() { ticks++; return RUNNING; } })), {
    onListenerError: error => errors.push(error)
  });
  debug.subscribe(() => { outcomes.push(debug.command({ type: 'tick' })); throw Error('observer'); });
  debug.subscribe(s => revisions.push(s.revision));
  debug.command({ type: 'tick' });
  assert.equal(ticks, 1); assert.equal(errors.length, 2);
  assert.deepEqual(revisions, [0, 1]); assert.ok(outcomes.every(r => r.code === 'BUSY'));
});

test('duplicate listeners unsubscribe independently and disposal leaves a waiting runner alive', () => {
  let cancelled = 0, notifications = 0;
  const source = createRunner(action({ id: 'a', tick: () => RUNNING, cancel: () => cancelled++ }));
  const debug = createDebugger(source), listener = () => notifications++;
  const off = debug.subscribe(listener); debug.subscribe(listener); off();
  debug.runner.tick(); assert.equal(notifications, 3);
  debug.dispose(); assert.equal(cancelled, 0); assert.equal(source.snapshot().status, RUNNING);
  debug.runner.cancel(); assert.equal(cancelled, 1);
});
