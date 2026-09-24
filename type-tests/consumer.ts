import { action, sequence, selector, condition, inverter, forceSuccess, forceFailure, retry, repeat, delay, timeout, cooldown, createRunner, SUCCESS, RUNNING } from 'bhtrees';
import type { ActionContext, Clock, NodeDefinition, RunnerSnapshot, WaitDescriptor } from 'bhtrees';

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
