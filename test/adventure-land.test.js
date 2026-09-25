import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAdventureLandSession } from 'bhtrees/adventure-land';

function clock() {
  let serial = 0;
  const timers = new Map(), history = [];
  return {
    setTimeout(fn) { const id = ++serial; timers.set(id, fn); history.push(fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire() { for (const [id, fn] of [...timers]) if (timers.delete(id)) fn(); },
    late() { for (const fn of history) fn(); },
    get size() { return timers.size; }
  };
}
function fixture(implementation, cleanup = () => {}) {
  const calls = [], timer = clock();
  const host = {
    clock: timer, services: { character: { name: 'Hero' } },
    readDocument(uri) {
      calls.push(uri);
      return { codec: 'json', text: uri.endsWith('tree.json') ? JSON.stringify({
        format: 'bhtrees', version: 1, kind: 'tree', root: 'a', configFile: '../config/settings.json',
        nodes: [{ id: 'a', type: 'action', implementation: 'game.run', implementationVersion: 1 }]
      }) : JSON.stringify({ format: 'bhtrees', version: 1, kind: 'config', config: { extensions: [{ path: './plugin.js' }] } }) };
    },
    importModule(uri) {
      calls.push(uri);
      return { id: 'game', version: '1', apiVersion: 1,
        setup(api) { api.registerAction('game.run', implementation); api.onDispose(cleanup); } };
    }
  };
  return { host, timer, calls };
}

test('host scheme loading preserves config bases and game services; execution starts explicitly', async () => {
  const f = fixture({ tick: c => c.success(c.services.character.name) });
  const session = await loadAdventureLandSession('./trees/tree.json', { host: f.host, baseURI: 'al://slots/bot/' });
  assert.deepEqual(f.calls, ['al://slots/bot/trees/tree.json', 'al://slots/bot/config/settings.json', 'al://slots/bot/config/plugin.js']);
  assert.equal(session.runner.snapshot().status, 'idle'); assert.equal(f.timer.size, 0);
  session.start(); session.start(); assert.equal(f.timer.size, 1);
  f.timer.fire(); assert.equal(session.runner.snapshot().output, 'Hero'); assert.equal(f.timer.size, 0);
  await session.dispose(); assert.throws(() => session.start(), /disposed/);
});

test('pause retains completions; disposal interrupts work immediately before extension cleanup', async () => {
  let token; const events = [];
  const f = fixture({ enter(c) { token = c.wait.callback({ resume: 'done' }); return token.wait; },
    resume: { done: () => assert.fail('cancelled continuation') }, cancel: () => events.push('cancel') }, () => events.push('extension'));
  const session = await loadAdventureLandSession('al://slots/tree.json', { host: f.host });
  session.start(); f.timer.fire(); session.runner.pause(); token.resolve(42); f.timer.fire();
  assert.equal(session.runner.snapshot().queuedResumes, 1);
  const disposal = session.dispose();
  assert.equal(session.dispose(), disposal); assert.equal(f.timer.size, 0);
  assert.equal(session.runner.snapshot().status, 'cancelled'); assert.deepEqual(events, ['cancel']);
  f.timer.late(); assert.equal(token.resolve(), false);
  await disposal; assert.deepEqual(events, ['cancel', 'extension']);
});

test('session shares its host clock for scheduler and wait timers and supports continue', async () => {
  const f = fixture({ enter: c => c.wait.timer(100, { resume: 'done' }), resume: { done: c => c.success() } });
  const session = await loadAdventureLandSession('al://slots/tree.json', { host: f.host });
  session.start(); f.timer.fire(); assert.equal(f.timer.size, 2);
  session.runner.pause(); f.timer.fire(); assert.equal(session.runner.snapshot().queuedResumes, 1);
  session.runner.continue(); f.timer.fire(); assert.equal(session.runner.snapshot().status, 'SUCCESS');
  assert.equal(f.timer.size, 0); await session.dispose();
});

test('invalid scheduling options and service collisions roll back extension setup', async () => {
  let cleanups = 0;
  const f = fixture({ tick: c => c.success() }, () => cleanups++);
  await assert.rejects(loadAdventureLandSession('al://slots/tree.json', { host: f.host, scheduler: { intervalMs: 0 } }), /intervalMs/);
  assert.equal(cleanups, 1); assert.equal(f.timer.size, 0);
  f.host.importModule = () => ({ id: 'game', version: '1', apiVersion: 1, setup(api) {
    api.registerAction('game.run', { tick: c => c.success() });
    api.registerService('character', {}); api.onDispose(() => cleanups++);
  } });
  await assert.rejects(loadAdventureLandSession('al://slots/tree.json', { host: f.host }), /Service conflicts/);
  assert.equal(cleanups, 2);
});

test('aborting pending loading releases acquired resources and never schedules work', async () => {
  const controller = new AbortController(); let cleaned = 0;
  const f = fixture({ tick: c => c.success() });
  f.host.importModule = () => ({ id: 'game', version: '1', apiVersion: 1, setup(api) {
    api.registerAction('game.run', { tick: c => c.success() }); api.onDispose(() => cleaned++);
    controller.abort(new Error('host destroyed'));
  } });
  await assert.rejects(loadAdventureLandSession('al://slots/tree.json', { host: f.host, signal: controller.signal }), /host destroyed/);
  assert.equal(cleaned, 1); assert.equal(f.timer.size, 0);
});

test('disposal attempts all cleanup and reports cancellation and extension failures', async () => {
  const f = fixture({ tick: () => 'RUNNING', cancel() { throw Error('cancel failed'); } }, () => { throw Error('extension failed'); });
  const session = await loadAdventureLandSession('al://slots/tree.json', { host: f.host });
  session.start(); f.timer.fire();
  await assert.rejects(session.dispose(), error => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(f.timer.size, 0);
});
