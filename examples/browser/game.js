import { createRegistry, RUNNING } from '../../dist/index.js';
import { loadMissionTree } from './mission-loader.js';

// Tune the simulation here. Times are in seconds; speed is world units per second.
const SCAN_SECONDS = 1.2;
const DRILL_SECONDS = 0.7;
const TRAVEL_SPEED = 35;
const BASE = { x: 12, y: 50 };

export function createWorld() {
  return {
    time: 0,
    radarPing: false,
    x: BASE.x,
    y: BASE.y,
    destination: null,
    speed: 0,
    cargo: 0,
    delivered: 0,
    phase: 'Ready at base',
    // Add, remove, or move crystals. The mission ends when all have been delivered.
    crystals: [
      { id: 'A', x: 40, y: 25, remaining: true },
      { id: 'B', x: 73, y: 68, remaining: true },
      { id: 'C', x: 87, y: 24, remaining: true }
    ]
  };
}

// The tree sets movement intent. Only the world update actually moves the rover.
export function advanceWorld(world, seconds) {
  world.time += seconds;
  if (!world.destination || world.speed <= 0) return;

  const dx = world.destination.x - world.x;
  const dy = world.destination.y - world.y;
  const distance = Math.hypot(dx, dy);
  const step = seconds * world.speed;
  if (distance <= step) {
    world.x = world.destination.x;
    world.y = world.destination.y;
    world.destination = null;
    world.speed = 0;
  } else {
    world.x += dx / distance * step;
    world.y += dy / distance * step;
  }
}

export function secondsUntilArrival(world) {
  if (!world.destination || world.speed <= 0) return Infinity;
  return Math.hypot(world.destination.x - world.x, world.destination.y - world.y) / world.speed;
}

export function createMission(world, json, log = () => {}) {
  function cancel() {
    world.destination = null;
    world.speed = 0;
    world.radarPing = false;
    world.phase = 'Mission cancelled';
  }

  function scan(ctx) {
    world.phase = 'Scanning - send a radar ping to skip the delay';
    ctx.local.startedAt ??= world.time;
    const elapsed = world.time - ctx.local.startedAt;
    if (!world.radarPing && elapsed < SCAN_SECONDS) return RUNNING;

    const source = world.radarPing ? 'radar ping' : 'auto scan';
    world.radarPing = false;
    const remaining = world.crystals.filter(crystal => crystal.remaining);
    const distance = crystal => Math.hypot(crystal.x - world.x, crystal.y - world.y);
    const target = remaining.sort((a, b) => distance(a) - distance(b))[0];
    if (!target) return ctx.failure('No crystals remain');

    log(`Expedition ${world.delivered + 1}: ${source}; target ${target.id}`);
    return ctx.success({ ...target });
  }

  function travel(ctx, destination, description) {
    if (!ctx.local.started) {
      world.destination = { x: destination.x, y: destination.y };
      world.speed = TRAVEL_SPEED;
      world.phase = description;
      ctx.local.started = true;
    }
    return world.destination ? RUNNING : ctx.success({ x: world.x, y: world.y });
  }

  function mine(ctx) {
    world.phase = 'Charging drill';
    ctx.local.startedAt ??= world.time;
    const elapsed = world.time - ctx.local.startedAt;
    const distanceToTarget = Math.hypot(world.x - ctx.input.x, world.y - ctx.input.y);
    if (elapsed < DRILL_SECONDS || distanceToTarget >= 1) return RUNNING;

    const crystal = world.crystals.find(item => item.id === ctx.input.id);
    crystal.remaining = false;
    world.cargo = 1;
    log(`Collected crystal ${crystal.id}`);
    return ctx.success({ crystal: crystal.id });
  }

  function unload(ctx) {
    world.delivered += world.cargo;
    world.cargo = 0;
    world.phase = 'Cargo secured';
    log(`Delivered ${world.delivered} / ${world.crystals.length} crystals`);
    return ctx.success({ delivered: world.delivered });
  }

  function report(ctx) {
    world.phase = 'All crystals delivered';
    return ctx.success({ agent: ctx.input?.name, delivered: world.delivered, mission: 'complete' });
  }

  // These names are the implementation fields in mission.json.
  const registry = createRegistry();
  registry.registerAction('game.scan', { tick: scan, cancel });
  registry.registerAction('game.outbound', { tick: ctx => travel(ctx, ctx.input, 'Travel to crystal'), cancel });
  registry.registerAction('game.mine', { tick: mine, cancel });
  registry.registerAction('game.home', { tick: ctx => travel(ctx, BASE, 'Return to base'), cancel });
  registry.registerAction('game.unload', { tick: unload, cancel });
  registry.registerAction('game.report', { tick: report, cancel });
  registry.registerCondition('game.crystalsRemain', () => world.crystals.some(crystal => crystal.remaining));
  registry.registerCondition('game.harvestComplete', () =>
    world.crystals.every(crystal => !crystal.remaining) && world.cargo === 0 && world.destination === null);

  return loadMissionTree(json, registry);
}
