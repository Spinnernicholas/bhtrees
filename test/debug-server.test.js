import test from 'node:test';
import assert from 'node:assert/strict';
import { action, createRunner, createDebugger, sequence, RUNNING } from '../dist/index.js';
import { startDebuggerServer } from 'bhtrees/node';
import { createRemoteDebugger } from 'bhtrees/browser';
import { inspectDebugValue } from '../dist/debug-wire.js';

async function setup(t) {
  const tree = sequence({ id: 'root', steps: [{ node: action({ id: 'running', tick: () => RUNNING }) }] });
  const debug = createDebugger(createRunner(tree));
  const server = await startDebuggerServer({ client: debug, tree });
  t.after(() => server.close());
  const url = new URL(server.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  const remote = createRemoteDebugger({ url: url.origin, token });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return { tree, debug, server, url, remote, headers };
}

test('HTTP remote client resynchronizes definitions and snapshots and drives validated controls', async t => {
  const { debug, remote } = await setup(t);
  const initial = await remote.read();
  assert.equal(initial.version, 1); assert.equal(initial.definition.root, 'root');
  assert.deepEqual(initial.definition.nodes.map(n => n.id), ['root', 'running']);
  assert.equal(initial.snapshot.runner.status, 'idle');
  assert.equal((await remote.command({ type: 'stepInto' })).result.ok, true);
  assert.equal((await remote.read()).snapshot.runner.paused, true);
  assert.equal((await remote.command({ type: 'tick' })).result.code, 'INVALID_STATE');
  await remote.command({ type: 'continue' }); await remote.command({ type: 'tick' });
  assert.equal(debug.runner.snapshot().status, RUNNING);
  const current = await remote.read(); assert.ok(current.snapshot.revision > initial.snapshot.revision);
  assert.ok(current.events.some(event => event.nodeId === 'running'));
  assert.equal(current.events.at(-1).transition, current.snapshot.runner.transitions);
  assert.equal(current.droppedEvents, 0);
  await remote.command({ type: 'cancel', reason: 'remote test' });
  assert.equal((await remote.read()).snapshot.runner.status, 'cancelled');
});

test('server serves UI and rejects missing credentials, cross-origin commands and invalid bodies', async t => {
  const { url, headers } = await setup(t);
  const root = await fetch(url.origin);
  assert.equal(root.status, 200); assert.match(await root.text(), /BHTrees remote debugger/);
  assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(url.origin + '/api/state')).status, 401);
  assert.equal((await fetch(url.origin + '/api/state', { headers: { ...headers, Origin: 'https://other.test' } })).status, 403);
  for (const [body, status] of [['{', 400], ['x'.repeat(4097), 413]]) {
    assert.equal((await fetch(url.origin + '/api/command', { method: 'POST', headers, body })).status, status);
  }
  const unknown = await fetch(url.origin + '/api/command', { method: 'POST', headers, body: JSON.stringify({ type: 'bad' }) });
  assert.equal((await unknown.json()).result.code, 'INVALID_COMMAND');
  assert.equal((await fetch(url.origin + '/api/command', { method: 'POST', headers: { Authorization: headers.Authorization }, body: '{}' })).status, 415);
});

test('closing transport is idempotent and leaves controller and runtime alive', async t => {
  const { debug, server, remote } = await setup(t);
  await remote.command({ type: 'tick' });
  const closing = server.close(); assert.equal(server.close(), closing); await closing;
  assert.equal(debug.runner.snapshot().status, RUNNING);
  assert.equal(debug.command({ type: 'pause' }).ok, true);
  await assert.rejects(remote.read());
});

test('remote clients install, hit and remove entry breakpoints', async t => {
  const { remote } = await setup(t);
  assert.equal((await remote.command({ type: 'setBreakpoint', nodeId: 'running' })).result.ok, true);
  await remote.command({ type: 'tick' });
  const stopped = await remote.read();
  assert.equal(stopped.snapshot.runner.paused, true);
  assert.equal(stopped.breakpointHit.nodeId, 'running');
  assert.equal(stopped.breakpoints.length, 1);
  assert.equal(stopped.snapshot.runner.frames.find(frame => frame.nodeId === 'running').phase, 'enter');
  await remote.command({ type: 'removeBreakpoint', nodeId: 'running' });
  await remote.command({ type: 'continue' }); await remote.command({ type: 'tick' });
  assert.equal((await remote.read()).breakpointHit, null);
});

test('inspection safely describes cycles, errors, functions, accessors and bounded values', () => {
  const value = { error: new Error('boom'), fn() {}, bigint: 12n, text: 'x'.repeat(3000), get accessor() { assert.fail('getter'); } };
  value.self = value;
  const result = inspectDebugValue(value);
  assert.equal(result.error.message, 'boom'); assert.equal(result.fn.$debug, 'function');
  assert.equal(result.self.$debug, 'circular or shared reference');
  assert.equal(result.accessor.$debug, 'accessor'); assert.ok(result.text.length < 2100);
  const array = inspectDebugValue(Array.from({ length: 1000 }, () => 1));
  assert.equal(array.length, 201); assert.equal(array.at(-1).$debug, 'item limit');
});
