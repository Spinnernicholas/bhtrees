import { loadAdventureLandSession } from '../dist/adventure-land.js';

// Host-mocked demonstrator: no game account or game globals are used.
const events = [];
const session = await loadAdventureLandSession('al://demo/mission.json', {
  host: {
    readDocument: () => ({ codec: 'json', text: JSON.stringify({
      format: 'bhtrees', version: 1, kind: 'tree', root: 'travel',
      nodes: [{ id: 'travel', type: 'action', implementation: 'travel', implementationVersion: 1 }],
      config: { extensions: [{ name: 'movement' }] }
    }) }),
    services: {
      beginMove(resolve) { events.push('movement started'); this.arrived = resolve; },
      stopMove() { events.push('movement stopped'); },
      arrived: undefined
    }
  },
  extensions: { builtins: { movement: {
    id: 'movement', version: '1', apiVersion: 1,
    setup(api) {
      api.registerAction('travel', {
        enter(ctx) {
          const token = ctx.wait.callback({ resume: 'arrived' });
          ctx.services.beginMove(token.resolve);
          return token.wait;
        },
        resume: { arrived: ctx => ctx.success() },
        cancel: ctx => ctx.services.stopMove()
      });
      api.onDispose(() => events.push('extension disposed'));
    }
  } } }
});
// Manual driving is supported as well as session.start().
session.runner.tick();
await session.dispose();
console.log(events.join(' -> '));
