import { action, sequence, createRunner, createDebugger, createRunnerScheduler, createBlackboard } from '../dist/index.js';
import { startDebuggerServer } from '../dist/node.js';

const tree = sequence({ id: 'mission', steps: [
  { node: action({ id: 'prepare', tick: ctx => ctx.success({ ready: true }) }) },
  { node: action({ id: 'work', tick(ctx) { ctx.blackboard.set('ticks', (ctx.blackboard.get('ticks') ?? 0) + 1); return 'RUNNING'; } }) }
] });
const debug = createDebugger(createRunner(tree, { blackboard: createBlackboard({ ticks: 0 }) }));
debug.command({ type: 'pause' });
const scheduler = createRunnerScheduler(debug.runner, { intervalMs: 250 });
const server = await startDebuggerServer({ client: debug, tree });
scheduler.start();
console.log(`Open this private debugger URL in your browser:\n${server.url}`);
process.once('SIGINT', async () => {
  scheduler.dispose(); debug.runner.cancel('host shutdown'); debug.dispose(); await server.close();
});
