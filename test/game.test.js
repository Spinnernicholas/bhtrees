import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, RUNNING, SUCCESS } from '../src/index.js';
import { createWorld, advanceWorld, createMission } from '../examples/browser/game.js';

test('agent completes all expeditions and releases scan subscriptions', () => {
  const world = createWorld();
  let now = 0, serial = 0, listeners = 0;
  const timers = new Map();
  const clock = {
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const { tree } = createMission(world, () => { listeners++; return () => { listeners--; }; });
  const runner = createRunner(tree, { clock, input: { name: 'Scout' } });
  runner.tick();
  for (let i = 0; i < 600 && runner.snapshot().status === RUNNING; i++) {
    now += 100; advanceWorld(world, 0.1);
    for (const [id, timer] of timers) if (timer.due <= now) { timers.delete(id); timer.fn(); }
    runner.tick();
  }
  assert.equal(runner.snapshot().status, SUCCESS);
  assert.deepEqual(runner.snapshot().output, { agent: 'Scout', delivered: 3, mission: 'complete' });
  assert.equal(world.cargo, 0);
  assert.equal(world.x, 12); assert.equal(world.y, 50);
  assert.equal(listeners, 0); assert.equal(timers.size, 0);
  assert.ok(world.crystals.every(crystal => !crystal.remaining));
});

test('cancelling travel stops the agent destination', () => {
  const world = createWorld();
  const { tree } = createMission(world, emit => { emit('radar'); return () => {}; });
  const runner = createRunner(tree, { input: { name: 'Scout' } });
  runner.tick();
  assert.ok(world.destination);
  runner.cancel();
  const position = [world.x, world.y]; advanceWorld(world, 1);
  assert.deepEqual([world.x, world.y], position);
  assert.equal(world.destination, null);
});
