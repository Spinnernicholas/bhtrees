import test from 'node:test';
import assert from 'node:assert/strict';
import { action, sequence, parallel, timeout, createRunner, createDebugger, RUNNING, SUCCESS } from '../dist/index.js';

test('every counted transition emits ordered metadata with its resulting snapshot', () => {
  const runner = createRunner(sequence({ id: 'root', steps: [
    { node: action({ id: 'a', tick: c => c.success(1) }) },
    { node: action({ id: 'b', tick: c => c.success(2) }) }
  ] }));
  const events = []; runner.subscribe(event => events.push(event));
  assert.equal(events.length, 0);
  const state = runner.tick();
  assert.equal(events.length, state.transitions);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  assert.deepEqual(events.map(e => e.snapshot.transitions), events.map((_, i) => i + 1));
  assert.equal(events.at(-1).snapshot.status, SUCCESS);
  assert.ok(events.some(e => e.nodeId === 'a' && e.activationId !== null));
  assert.ok(events.every(e => Object.isFrozen(e) && Object.isFrozen(e.snapshot)));
});

test('event observers may pause at a boundary, but cannot reenter or break execution', () => {
  let calls = 0; const errors = [];
  const runner = createRunner(action({ id: 'a', tick() { calls++; return RUNNING; } }), { onEventError: error => errors.push(error) });
  const off = runner.subscribe(() => { runner.step(); });
  runner.subscribe(() => { throw Error('observer failed'); });
  runner.tick();
  assert.equal(calls, 1); assert.equal(runner.snapshot().paused, false); assert.ok(errors.length >= 2);
  off();
  const stop = runner.subscribe(() => runner.pause());
  runner.tick(); assert.equal(runner.snapshot().paused, true); stop();
  runner.continue(); runner.tick(); assert.equal(calls, 3);
});

test('parallel branch suspension and timeout completion events identify their boundaries', () => {
  const parallelRunner = createRunner(parallel({ id: 'p', successThreshold: 2, failureThreshold: 1, steps: [
    { node: action({ id: 'wait', tick: () => RUNNING }) },
    { node: action({ id: 'done', tick: () => SUCCESS }) }
  ] }));
  const events = []; parallelRunner.subscribe(e => events.push(e)); parallelRunner.tick();
  assert.equal(events.length, parallelRunner.snapshot().transitions);
  assert.ok(events.some(e => e.nodeId === 'wait')); assert.ok(events.some(e => e.nodeId === 'done'));
  let expire;
  const runner = createRunner(timeout({ id: 'timeout', ms: 10, child: action({ id: 'child', tick: () => RUNNING }) }), {
    clock: { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} }
  });
  const timed = []; runner.subscribe(e => timed.push(e)); runner.tick(); expire(); runner.tick();
  assert.equal(timed.at(-1).nodeId, 'timeout'); assert.equal(timed.at(-1).snapshot.status, 'FAILURE');
});

test('errors and cancellation emit once with cleanup results, without synthetic transitions', () => {
  const runner = createRunner(action({ id: 'bad', tick() { throw Error('boom'); } }));
  const events = []; runner.subscribe(e => events.push(e)); runner.tick();
  assert.equal(events.at(-1).type, 'error'); assert.equal(events.at(-1).snapshot.error.message, 'boom');
  const count = events.length; runner.tick(); runner.cancel(); assert.equal(events.length, count);
  const active = createRunner(action({ id: 'a', tick: () => RUNNING }));
  const cancelled = []; active.subscribe(e => cancelled.push(e)); active.tick();
  active.cancel('shutdown'); active.cancel('again');
  assert.equal(cancelled.filter(e => e.type === 'cancel').length, 1);
  assert.equal(cancelled.at(-1).reason, 'shutdown');
});

test('debugger timeline retains bounded metadata independent of live value mutation', () => {
  const runner = createRunner(action({ id: 'a', tick: c => { c.local.count = (c.local.count ?? 0) + 1; return RUNNING; } }));
  const debug = createDebugger(runner, { eventLimit: 3 });
  for (let i = 0; i < 10; i++) debug.runner.tick();
  const snapshot = debug.snapshot();
  assert.equal(snapshot.events.length, 3); assert.ok(snapshot.droppedEvents > 0);
  assert.equal(snapshot.events.at(-1).transition, snapshot.runner.transitions);
  assert.ok(snapshot.events.every(e => !('snapshot' in e)));
  const old = JSON.stringify(snapshot.events); debug.runner.tick(); assert.equal(JSON.stringify(snapshot.events), old);
  debug.dispose(); debug.runner.tick(); assert.equal(debug.snapshot().revision, snapshot.revision + 1);
  assert.throws(() => createDebugger(runner, { eventLimit: -1 }), /event limit/);
  const disabled = createDebugger(runner, { eventLimit: 0 }); disabled.runner.tick();
  assert.equal(disabled.snapshot().events.length, 0); disabled.dispose();
});
