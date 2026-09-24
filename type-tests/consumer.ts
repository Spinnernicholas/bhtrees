import { action, sequence, selector, condition, inverter, forceSuccess, forceFailure, retry, repeat, delay, timeout, cooldown, subtree, parallel, createRegistry, encodeTree, decodeTree, toTreeDocument, fromTreeDocument, createBlackboard, createRunner, SUCCESS, RUNNING } from 'bhtrees';
import type { ActionImplementation, ActionContext, Clock, NodeDefinition, RunnerSnapshot, WaitDescriptor } from 'bhtrees';

const clock: Clock = { setTimeout: () => ({ id: 1 }), clearTimeout: handle => { void handle; } };
const work = action({
  id: 'work',
  enter(ctx) {
    const wait: WaitDescriptor = ctx.wait.all([
      ctx.wait.promise(Promise.resolve(1)),
      ctx.wait.timer(5, { value: 'elapsed' }),
      ctx.wait.event(notify => { notify('ready'); return () => {}; }),
      ctx.wait.poll(() => true)
    ], { resume: 'done' });
    return wait;
  },
  resume: { done: (ctx, values) => ctx.success(values) },
  cancel: (ctx, reason) => { ctx.local.reason = reason; }
});
const tree: NodeDefinition = sequence({ id: 'root', reactive: true, steps: [
  { node: work, save: 'result', input: scope => scope.input },
  { node: action({ id: 'tick', tick: ctx => ctx.local.ready ? SUCCESS : RUNNING }) }
], output: scope => scope.vars.result });
const runner = createRunner(tree, { clock, input: { name: 'agent' } });
const snapshot: RunnerSnapshot = runner.tick();
runner.step(); runner.pause(); runner.continue(); runner.cancel();
if (snapshot.frames[0]) {
  // @ts-expect-error Snapshot structures are readonly.
  snapshot.frames[0].phase = 'enter';
}
// @ts-expect-error An action must have exactly one execution callback.
action({ id: 'invalid', enter: () => SUCCESS, tick: () => SUCCESS });
// @ts-expect-error Action results must use supported statuses.
action({ id: 'invalid-result', tick: () => 'finished' });
// @ts-expect-error Reactivity has three supported settings.
sequence({ id: 'invalid-reactive', steps: [], reactive: 'always' });
function invalidWait(ctx: ActionContext) {
  // @ts-expect-error Event subscriptions must return a disposer.
  ctx.wait.event(() => {});
  // @ts-expect-error Timer delay is numeric.
  ctx.wait.timer('soon');
}
void invalidWait;

const priority: NodeDefinition = selector({ id: 'priority', reactive: true, steps: [
  { node: condition({ id: 'ready', test: ctx => ctx.input.ready === true }) },
  { node: tree, save: 'fallback' }
], output: scope => scope.last });
createRunner(priority);
// @ts-expect-error Conditions must return boolean values synchronously.
condition({ id: 'async', test: async () => true });
// @ts-expect-error Conditions cannot return behavior statuses.
condition({ id: 'status', test: () => SUCCESS });
condition({ id: 'no-wait', test: ctx => {
  // @ts-expect-error Conditions cannot register waits.
  ctx.wait.timer(1);
  return true;
} });
// @ts-expect-error Selectors require node definitions in their steps.
selector({ id: 'invalid-step', steps: [{ node: {} }] });

const decorated: NodeDefinition = inverter({ id: 'invert', child: forceSuccess({ id: 'success',
  child: forceFailure({ id: 'failure', reactive: false, child: priority }) }) });
createRunner(decorated);
// @ts-expect-error Decorators require one child definition.
inverter({ id: 'missing-child' });
// @ts-expect-error Decorators accept one child, not a steps array.
forceSuccess({ id: 'many', steps: [{ node: tree }] });
// @ts-expect-error Decorator children must be node definitions.
forceFailure({ id: 'invalid-child', child: {} });

createRunner(retry({ id: 'retry', child: decorated, attempts: 3 }));
createRunner(repeat({ id: 'repeat', child: decorated, times: Infinity }));
const completed: number | undefined = snapshot.frames[0]?.completedIterations;
void completed;
// @ts-expect-error Retry requires an explicit total-attempt limit.
retry({ id: 'missing-limit', child: tree });
// @ts-expect-error Repeat requires a numeric iteration count.
repeat({ id: 'bad-limit', child: tree, times: 'forever' });

createRunner(delay({ id: 'delay', ms: 20, child: tree }));
createRunner(timeout({ id: 'timeout', ms: 100, child: decorated }));
createRunner(cooldown({ id: 'cooldown', ms: 50, child: priority }));
// @ts-expect-error Timed decorators require an explicit duration.
delay({ id: 'missing-duration', child: tree });
// @ts-expect-error Durations are numbers, not strings.
timeout({ id: 'bad-duration', ms: '100', child: tree });
// @ts-expect-error Cooldown wraps a node definition.
cooldown({ id: 'bad-child', ms: 10, child: {} });

createRunner(subtree({ id: 'call', child: tree, input: scope => scope.input,
  output: (scope, result) => {
    // @ts-expect-error Subtree output mappings cannot change the child status.
    result.status = 'SUCCESS';
    return { value: scope.last, status: result.status };
  }
}));
const parentId: number | null = snapshot.frames[0].parentActivationId;
void parentId;
// @ts-expect-error Subtree input bindings are functions.
subtree({ id: 'invalid-input', child: tree, input: 42 });
// @ts-expect-error Subtree calls require a child definition.
subtree({ id: 'missing-definition' });

createRunner(parallel({ id: 'parallel', successThreshold: 2, failureThreshold: 1,
  steps: [{ node: tree }, { node: decorated, input: scope => scope.input }],
  output: (results, status) => {
    // @ts-expect-error Parallel completion arrays are readonly.
    results[0] = undefined;
    return { status, values: results.map(result => result?.output) };
  }
}));
// @ts-expect-error Parallel requires explicit thresholds.
parallel({ id: 'missing-policy', steps: [{ node: tree }] });
parallel({ id: 'invalid-save', successThreshold: 1, failureThreshold: 1,
  // @ts-expect-error Parallel outputs require a reducer instead of shared saves.
  steps: [{ node: tree, save: 'collision' }]
});

const board = createBlackboard({ count: 0 });
const unsubscribe = board.subscribe(change => {
  const revision: number = change.revision;
  // @ts-expect-error Change records are readonly.
  change.key = 'changed';
  void revision;
});
board.set('count', board.get('count') + 1);
board.has('count'); board.delete('count'); unsubscribe();
createRunner(condition({ id: 'board-condition', test: ctx => ctx.blackboard?.has('ready') ?? false }), { blackboard: board });
// @ts-expect-error Blackboard keys must be strings.
board.set(42, 'value');
// @ts-expect-error Snapshot containers are readonly.
board.snapshot().values.count = 1;
// @ts-expect-error Runner board injection must implement the blackboard API.
createRunner(tree, { blackboard: {} });

action({ id: 'callback', enter(ctx) {
  const token = ctx.wait.callback({ resume: 'done', reject: 'failed' });
  const accepted: boolean = token.resolve(42);
  token.reject(new Error('ignored after resolution'));
  void accepted;
  // @ts-expect-error Callback tokens are handles, not wait descriptors.
  ctx.wait.any([token]);
  return token.wait;
}, resume: { done: (ctx, value) => ctx.success(value), failed: (ctx, error) => ctx.failure(error) } });

const pathTree = sequence({ id: 'paths', steps: [
  { node: tree, input: { path: ['input', 'items', 0] }, save: 'value' }
], output: { path: ['vars', 'value'] } });
createRunner(subtree({ id: 'path-call', child: pathTree, output: { path: ['result', 'output'] } }));
createRunner(parallel({ id: 'path-parallel', steps: [{ node: pathTree }],
  successThreshold: 1, failureThreshold: 1, output: { path: ['results', 0, 'output'] } }));
// @ts-expect-error Declarative paths are segment arrays, not expressions.
sequence({ id: 'bad-path', steps: [], output: { path: 'vars.value' } });
// @ts-expect-error Path segments are strings or numbers.
subtree({ id: 'bad-segment', child: tree, input: { path: [true] } });

const registry = createRegistry();
const implementation: ActionImplementation = { tick: () => SUCCESS };
registry.registerAction('app.success', implementation, 1);
registry.registerCondition('app.ready', ctx => ctx.input === true);
const portable = action({ id: 'portable', ...implementation });
createRunner(decodeTree(encodeTree(portable, { registry }), { registry }));
fromTreeDocument(toTreeDocument(portable, { registry }), { registry });
// @ts-expect-error Action implementations require enter or tick.
registry.registerAction('app.invalid', {});
// @ts-expect-error Conditions are synchronous boolean predicates.
registry.registerCondition('app.async', async () => true);
