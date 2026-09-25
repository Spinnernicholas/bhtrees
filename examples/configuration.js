import { readFile } from 'node:fs/promises';
import { action, createRegistry, encodeTree, loadConfiguredTree } from '../dist/index.js';

const registry = createRegistry();
const implementation = { tick(ctx) {
  const visits = ctx.blackboard.get('visits') + 1;
  ctx.blackboard.set('visits', visits);
  return ctx.success(`${ctx.blackboard.get('greeting')}, ${ctx.input}! Visit ${visits}`);
} };
registry.registerAction('example.greet', implementation);
const tree = action({ id: 'greet', ...implementation });
const text = encodeTree(tree, { registry, codec: 'yaml', configFile: './configuration.yaml',
  config: { blackboard: { initial: { greeting: 'Welcome' } } } });
const loaded = await loadConfiguredTree(text, {
  registry, codec: 'yaml', baseURI: import.meta.url,
  readConfig: async uri => ({ text: await readFile(new URL(uri), 'utf8'), codec: 'yaml' }),
  overrides: { runtime: { maxStepsPerTick: 2 } }
});
console.log(loaded.config);
console.log(loaded.provenance);
// Each configured runner starts with a fresh blackboard.
for (const name of ['first runner', 'second runner']) {
  const runner = loaded.createRunner({ input: name });
  let state = runner.tick();
  while (state.status === 'RUNNING') state = runner.tick();
  console.log(state.output);
}
