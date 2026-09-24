import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, RUNNING, SUCCESS } from '../dist/index.js';
import { createWorld, advanceWorld, createMission, secondsUntilArrival } from '../examples/browser/game.js';

test('world movement uses target and speed without running the behavior tree', () => {
  const world = createWorld();
  world.destination = { x: 42, y: 90 };
  world.speed = 10;
  assert.equal(secondsUntilArrival(world), 5);
  advanceWorld(world, 2);
  assert.equal(world.x, 24);
  assert.equal(world.y, 66);
  world.speed = 20;
  assert.equal(secondsUntilArrival(world), 1.5);
  advanceWorld(world, 2);
  assert.deepEqual([world.x, world.y], [42, 90]);
  assert.equal(world.destination, null);
  assert.equal(world.speed, 0);
  assert.equal(secondsUntilArrival(world), Infinity);
});

test('tree sets movement intent while only world updates change position', () => {
  const world = createWorld();
  const { tree } = createMission(world);
  const runner = createRunner(tree);
  world.radarPing = true;
  runner.tick();
  assert.deepEqual(world.destination, { x: 40, y: 25 });
  assert.equal(world.speed, 35);
  runner.tick(); runner.step();
  assert.deepEqual([world.x, world.y], [12, 50]);
  advanceWorld(world, 0.1);
  assert.notEqual(world.x, 12);
  runner.cancel();
  assert.equal(world.speed, 0);
});

test('agent completes all expeditions using ordinary ticks', () => {
  const world = createWorld();
  const { tree } = createMission(world);
  const runner = createRunner(tree, { input: { name: 'Scout' } });
  runner.tick();
  for (let i = 0; i < 600 && runner.snapshot().status === RUNNING; i++) {
    advanceWorld(world, 0.1);
    runner.tick();
  }
  assert.equal(runner.snapshot().status, SUCCESS);
  assert.deepEqual(runner.snapshot().output, { agent: 'Scout', delivered: 3, mission: 'complete' });
  assert.equal(world.cargo, 0);
  assert.equal(world.x, 12); assert.equal(world.y, 50);
  assert.equal(runner.snapshot().queuedResumes, 0);
  assert.ok(world.crystals.every(crystal => !crystal.remaining));
});

test('cancelling travel stops the agent destination', () => {
  const world = createWorld();
  const { tree } = createMission(world);
  const runner = createRunner(tree, { input: { name: 'Scout' } });
  world.radarPing = true;
  runner.tick();
  assert.ok(world.destination);
  runner.cancel();
  const position = [world.x, world.y]; advanceWorld(world, 1);
  assert.deepEqual([world.x, world.y], position);
  assert.equal(world.destination, null);
});
