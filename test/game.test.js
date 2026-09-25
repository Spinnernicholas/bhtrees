import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRunner, parseYaml, RUNNING, SUCCESS } from '../dist/index.js';
import { createWorld, advanceWorld, createMission, secondsUntilArrival } from '../examples/browser/game.js';

const missionJSON = await readFile(new URL('../examples/browser/mission.json', import.meta.url), 'utf8');
const missionYAML = await readFile(new URL('../examples/browser/mission.yaml', import.meta.url), 'utf8');

test('YAML mission matches JSON and completes all expeditions', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseYaml(missionYAML))), JSON.parse(missionJSON));
  const world = createWorld();
  const mission = createMission(world, missionYAML, () => {}, 'yaml');
  assert.deepEqual(mission.labels, createMission(createWorld(), missionJSON).labels);
  const runner = createRunner(mission.tree, { input: { name: 'YAML Scout' } });
  runner.tick();
  for (let i = 0; i < 600 && runner.snapshot().status === RUNNING; i++) {
    advanceWorld(world, 0.1); runner.tick();
  }
  assert.equal(runner.snapshot().status, SUCCESS);
  assert.deepEqual(runner.snapshot().output, { agent: 'YAML Scout', delivered: 3, mission: 'complete' });
  assert.throws(() => createMission(createWorld(), 'root: [', () => {}, 'yaml'), /Flow collections/);
  assert.throws(() => createMission(createWorld(), missionJSON, () => {}, 'xml'), /Unsupported mission format/);
});

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
  const { tree } = createMission(world, missionJSON);
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
  const { tree } = createMission(world, missionJSON);
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
  const { tree } = createMission(world, missionJSON);
  const runner = createRunner(tree, { input: { name: 'Scout' } });
  world.radarPing = true;
  runner.tick();
  assert.ok(world.destination);
  runner.cancel();
  const position = [world.x, world.y]; advanceWorld(world, 1);
  assert.deepEqual([world.x, world.y], position);
  assert.equal(world.destination, null);
});

test('the JSON loop harvests zero, one, or more than three crystals', () => {
  for (const count of [0, 1, 5]) {
    const world = createWorld();
    world.crystals = Array.from({ length: count }, (_, i) => ({ id: `crystal-${i}`, x: 30 + i * 8, y: 30, remaining: true }));
    const { tree } = createMission(world, missionJSON);
    const runner = createRunner(tree, { input: { name: 'Looper' } });
    runner.tick();
    const activations = new Set();
    for (let i = 0; i < 2000 && runner.snapshot().status === RUNNING; i++) {
      const scan = runner.snapshot().frames.find(frame => frame.nodeId === 'expedition-scan');
      if (scan) activations.add(scan.activationId);
      advanceWorld(world, 0.1); runner.tick();
    }
    assert.equal(runner.snapshot().status, SUCCESS);
    assert.deepEqual(runner.snapshot().output, { agent: 'Looper', delivered: count, mission: 'complete' });
    assert.equal(activations.size, count);
    assert.equal(world.cargo, 0); assert.equal(world.destination, null);
    assert.ok(world.crystals.every(crystal => !crystal.remaining));
    const transitions = runner.snapshot().transitions;
    runner.tick(); assert.equal(runner.snapshot().transitions, transitions);
  }
});

test('the exhaustion fallback does not report completion with undelivered cargo', () => {
  const world = createWorld(); world.crystals = []; world.cargo = 1;
  const { tree } = createMission(world, missionJSON);
  assert.equal(createRunner(tree).tick().status, 'FAILURE');
});

test('malformed mission JSON fails before any game action runs', () => {
  const world = createWorld(), before = structuredClone(world);
  assert.throws(() => createMission(world, '{'), /Invalid JSON/);
  const document = JSON.parse(missionJSON);
  document.root.steps[1].node.implementation = 'game.missing';
  assert.throws(() => createMission(world, JSON.stringify(document)), /Unknown action/);
  assert.deepEqual(world, before);
});

test('mission labels are editable without changing action implementations', () => {
  const document = JSON.parse(missionJSON);
  document.root.label = 'My crystal mission';
  const { tree, labels } = createMission(createWorld(), JSON.stringify(document));
  assert.equal(tree.id, 'mission');
  assert.equal(labels.mission, 'My crystal mission');
  assert.equal(labels['expedition-scan'], 'Scan for crystals');
});

test('nested mission validation rejects duplicate IDs and misspelled fields', () => {
  const document = JSON.parse(missionJSON);
  document.root.steps[1].node.id = document.root.id;
  assert.throws(() => createMission(createWorld(), JSON.stringify(document)), /duplicate/i);
  document.root.steps[1].node.id = 'mission-report';
  document.root.steps[1].node.lable = 'Typo';
  assert.throws(() => createMission(createWorld(), JSON.stringify(document)), /lable/);
});
