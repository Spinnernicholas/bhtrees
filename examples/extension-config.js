import { resolveConfiguration } from '../dist/index.js';

// Declaration inspection only: this does not import or execute extension modules.
const resolved = resolveConfiguration([
  { source: { layer: 'file', uri: 'https://example.test/config/bot.yaml' }, config: {
    extensions: [
      { name: 'metrics', options: { counters: ['ticks', 'waits'] } },
      { id: 'combat', path: './combat.js', options: { retreatHealth: 0.25, searchRadius: 30 } }
    ]
  } },
  { source: { layer: 'embedded', uri: 'https://example.test/trees/mission.yaml' }, config: {
    extensions: [
      { id: 'combat', path: '../config/combat.js', enabled: false, options: { retreatHealth: 0.4 } }
    ]
  } }
]);
console.log(JSON.stringify(resolved, null, 2));
