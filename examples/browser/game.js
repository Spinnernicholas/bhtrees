import { action, sequence, RUNNING } from '../../dist/index.js';

export function createWorld() {
  return { time: 0, radarPing: false, x: 12, y: 50, destination: null, speed: 0, cargo: 0, delivered: 0, phase: 'Ready at base',
    crystals: [{ id: 'A', x: 40, y: 25, remaining: true }, { id: 'B', x: 73, y: 68, remaining: true },
      { id: 'C', x: 87, y: 24, remaining: true }] };
}

export function advanceWorld(world, seconds) {
  world.time += seconds;
  if (!world.destination || world.speed <= 0) return;
  const dx = world.destination.x - world.x, dy = world.destination.y - world.y;
  const distance = Math.hypot(dx, dy), step = seconds * world.speed;
  if (distance <= step) { world.x = world.destination.x; world.y = world.destination.y; world.destination = null; world.speed = 0; }
  else { world.x += dx / distance * step; world.y += dy / distance * step; }
}

// The debugger uses the same movement state as the world update loop.
export function secondsUntilArrival(world) {
  if (!world.destination || world.speed <= 0) return Infinity;
  return Math.hypot(world.destination.x - world.x, world.destination.y - world.y) / world.speed;
}

export function createMission(world, log = () => {}) {
  const labels = { mission: 'Crystal recovery mission' };
  function task(id, label, tick) {
    labels[id] = label;
    return action({ id, tick, cancel() { world.destination = null; world.speed = 0; world.radarPing = false; world.phase = 'Mission cancelled'; } });
  }
  function travel(id, label, destination) {
    return task(id, label, c => {
      if (!c.local.started) {
        world.destination = destination(c.input); world.speed = 35; world.phase = label;
        c.local.started = true;
      }
      return world.destination ? RUNNING : c.success({ x: world.x, y: world.y });
    });
  }
  const trips = [1, 2, 3].map(number => {
    const prefix = `trip-${number}`;
    labels[prefix] = `Expedition ${number}`;
    return { node: sequence({ id: prefix, steps: [
      { node: task(`${prefix}-scan`, 'Scan for crystals', c => {
        world.phase = 'Scanning — send a radar ping to skip the delay';
        c.local.startedAt ??= world.time;
        if (!world.radarPing && world.time - c.local.startedAt < 1.2) return RUNNING;
        const source = world.radarPing ? 'radar ping' : 'auto scan';
        world.radarPing = false;
        const target = world.crystals.filter(item => item.remaining).sort((a, b) =>
          Math.hypot(a.x - world.x, a.y - world.y) - Math.hypot(b.x - world.x, b.y - world.y))[0];
        if (!target) return c.failure('No crystals remain');
        log(`Expedition ${number}: ${source}; target ${target.id}`);
        return c.success({ ...target });
      }), save: 'target' },
      { node: travel(`${prefix}-outbound`, 'Travel to crystal', input => ({ x: input.x, y: input.y })), input: s => s.vars.target },
      { node: task(`${prefix}-mine`, 'Charge drill & extract', c => {
        world.phase = 'Charging drill';
        c.local.startedAt ??= world.time;
        if (world.time - c.local.startedAt < 0.7 ||
            Math.hypot(world.x - c.input.x, world.y - c.input.y) >= 1) return RUNNING;
        world.crystals.find(item => item.id === c.input.id).remaining = false;
        world.cargo = 1; log(`Collected crystal ${c.input.id}`); return c.success({ crystal: c.input.id });
      }), input: s => s.vars.target, save: 'cargo' },
      { node: travel(`${prefix}-home`, 'Return to base', () => ({ x: 12, y: 50 })) },
      { node: task(`${prefix}-unload`, 'Deposit cargo', c => {
        world.delivered += world.cargo; world.cargo = 0; world.phase = 'Cargo secured';
        log(`Delivered ${world.delivered} / 3 crystals`); return c.success({ delivered: world.delivered });
      }) }
    ] }) };
  });
  return { tree: sequence({ id: 'mission', steps: trips,
    output: scope => ({ agent: scope.input.name, delivered: world.delivered, mission: 'complete' }) }), labels };
}
