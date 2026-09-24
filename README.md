# BHTrees

Dependency-free JavaScript behavior trees for Node, browsers, and Adventure Land.
Development has started with the first engine slice; see [PLAN.md](PLAN.md) for the
full roadmap. The API is experimental.

```js
import { action, createRunner } from './dist/index.js';

const tree = action({
  id: 'hello',
  enter: ctx => ctx.success(`Hello, ${ctx.input.name}!`)
});
const runner = createRunner(tree, { input: { name: 'world' } });
console.log(runner.tick().output);
```

Run `npm ci` once to install the TypeScript development compiler, then `npm run build`
to compile `src/*.ts` into ESM JavaScript and generated declarations in `dist/`.
The published package has no runtime dependencies. Package imports use `bhtrees`;
local examples import the compiled `dist/index.js` entry point.

Run `npm test` for declaration checks and the Node built-in test suite, or
`npm run example` for a sequence with sibling data bindings. Tests and example
commands build automatically. `npm run typecheck` checks source without emitting;
`npm run build -- --watch` rebuilds during development. `npm pack` builds the
JavaScript and declarations before packaging.

The public types cover definitions, action contexts/results, waits, clocks, runners,
and snapshots. Application inputs, outputs, locals, services, and clock handles
remain permissive (`Value`, currently `any`); the engine does not infer data schemas
between nodes.

## Browser playground

Run `npm run example:browser`, then open **http://127.0.0.1:8080** in a modern browser.
The server binds to localhost only. Set `PORT` to use another port. Use the HTTP
server instead of opening the HTML as a local file, so ES-module imports work.

Click **Start** to launch a rover on three crystal-recovery expeditions; **Reset** returns it to idle.
Each expedition scans for the nearest deposit, travels to it, charges a drill,
collects a crystal, returns to base, and deposits its cargo. **Send radar ping**
skips the scan delay. The world shows movement, remaining deposits, cargo, and deliveries.
The example uses traditional tick actions: each evaluation returns `RUNNING`, `SUCCESS`,
or `FAILURE`, with no wait descriptors or resume handlers. Movement runs in the world
update loop from the target and speed set by the tree. Scan and drill delays use simulation time.
Pause freezes the simulation. Step advances one tree transition; reevaluating a running
action also advances simulation time by 0.1 seconds. Continue resumes automatic ticks.

**Blocks** (default) displays nested sequences with flush sibling seams and interlocking
connector tabs. **List** gives an indented alternative. Select a node to inspect its
activation. Both retain the dark/slate palette and mint active indicators. These are
execution views, not a drag-and-drop editor. The simulation clock is shown below the tree;
the last 100 UI observations appear in event history.

This is an initial list/block debugger example, not the full debugger controller or
renderer plugin API. Node and headless Chrome checks cover its execution controls,
connected block geometry, the complete agent mission, restart, and cancellation. To rerun the real
browser smoke test, build with `npm run build`, then use `node scripts/check-browser.js <path-to-Chrome-or-Edge>`.

Implemented: immutable action/condition/sequence/selector/decorator definitions, isolated runner frames, explicit
inputs/outputs and composite bindings, local activation state, promise/timer/event/poll waits with named
resume handlers, cancellation, bounded ticks, snapshots, and single-transition stepping.

`tick()` runs until completion, a running action, a wait, or its step budget. Promise settlement only
queues a continuation; call `tick()` again to process it. Terminal runners do not
restart. `pause()` prevents normal ticks; `step()` pauses and performs one engine
transition. `continue()` allows subsequent ticks. User callbacks run synchronously
and cannot be interrupted midway. Exceptions produce `errored`, separately from
behavior `FAILURE`. Cancellation disposes active actions in child-first order;
external operations must be stopped by the action's cancel hook.

Inputs, outputs, and application values are immutable by contract, not deeply copied.
Snapshots freeze their structural containers but are not historical deep snapshots.
Services are injected live APIs. Each runner owns its execution locals and scopes.

## Tick actions

Use `action({ id, tick })` for a traditional tick-based action. Its `tick(ctx)` function
is evaluated at most once per runner tick or debugger step. Return `RUNNING` to be
evaluated again on a later tick; return `SUCCESS` or `FAILURE` to finish. Use
`ctx.success(output)` or `ctx.failure(output)` when a result includes data.
`ctx.local` persists for that activation. A memory sequence retains its active child.
Choose either `tick` or `enter` for an action; the existing `enter`/`resume` API remains
available for asynchronous waits.

## Selectors and conditions

`condition({ id, test })` evaluates `test(ctx)` once per activation. It receives
`input`, `local`, and `services`; return `true` for `SUCCESS` or `false` for `FAILURE`.
Non-boolean results (including promises) produce an execution error. Exceptions
also produce `errored`. Conditions have no wait or resume API.

`selector({ id, steps, output?, reactive? })` tries children in declaration order.
It skips failures, stops on the first success, and retains a running or waiting
child. The default is memory behavior; `reactive: true` checks earlier priorities
again on each logical tick and interrupts displaced work. Reactivity inheritance,
stepping, budgets, and cleanup follow the same rules as sequences.

Steps accept `input(scope)` and `save`, just like sequence steps. Only successful
outputs are saved. `scope.last` exposes the previous child's output, including
failures, so a later input binding can explicitly inspect failure data. On success,
the selector calls `output(scope)` (default: `scope.last`). If every child fails,
it returns the last failure output without calling the output mapper. An empty
selector fails with `undefined` output; an empty sequence succeeds. Exceptions
stop execution rather than selecting a fallback.

```js
import { action, condition, selector, sequence, RUNNING } from './dist/index.js';

const priorities = selector({ id: 'priorities', reactive: true, steps: [
  { node: sequence({ id: 'urgent', steps: [
    { node: condition({ id: 'needs-help', test: c => c.services.needsHelp() }) },
    { node: action({ id: 'help', tick: c => c.services.help() }) }
  ] }) },
  { node: action({ id: 'patrol', tick: () => RUNNING,
    cancel: c => c.services.stopPatrol() }) }
] });
```

The `help` service returns a behavior result. If `needsHelp()` becomes true while
patrol is running, the selector switches to the urgent branch and cancels patrol.

## Result decorators

`inverter({ id, child, reactive? })`, `forceSuccess(...)`, and `forceFailure(...)`
wrap one child definition. They pass their input to the child and preserve its
completion output, including failure output. Use the enclosing composite step's
`input` binding to customize the decorator's input.

| Decorator | Child SUCCESS | Child FAILURE |
| --- | --- | --- |
| `inverter` | FAILURE | SUCCESS |
| `forceSuccess` | SUCCESS | SUCCESS |
| `forceFailure` | FAILURE | FAILURE |

A running or waiting child stays active until it completes. Exceptions remain
execution errors, and cancellation still cleans up the child and discards late
notifications. The decorators follow normal reactivity inheritance; an explicit
`reactive` setting controls the inherited setting of descendants. Reaching the
same running child preserves its activation and waits.

```js
import { condition, inverter } from './dist/index.js';

const notBlocked = inverter({ id: 'not-blocked', child:
  condition({ id: 'blocked', test: c => c.services.isBlocked(c.input) })
});
```

Decorators have their own activation frames. Entering the child and transforming
its completed result are separate engine transitions, visible when stepping. The
browser tree views display the wrapped child under its decorator.

## Retry and repeat

`retry({ id, child, attempts, reactive? })` retries a failed child until it succeeds
or reaches `attempts` total attempts (including the first). It returns the final
child's status and output. `attempts` must be a positive safe integer or `Infinity`.

`repeat({ id, child, times, reactive? })` repeats successful children, stops at the
first failure, and succeeds after `times` successes. It returns the last child's
output. `times` must be a nonnegative safe integer or `Infinity`; zero succeeds
without executing the child and returns no output. Both counts are required.

```js
import { action, retry, repeat } from './dist/index.js';

const delivery = retry({ id: 'delivery', attempts: 3, child:
  action({ id: 'try-delivery', tick: c => c.services.deliver(c.input) })
});
const deliveries = repeat({ id: 'deliveries', times: 5, child: delivery });
```

Each new attempt gets a fresh child activation, locals, and composite scope, with
the same input supplied to the decorator. A running/waiting attempt retains its
activation until completion. Errors stop execution immediately; cancellation or
reactive preemption releases current waits and prevents further attempts. Loop
counts belong to the decorator activation, so interrupting and later reentering
it resets the count. Snapshots expose `completedIterations` on retry/repeat frames
(starting at zero and counting all finished attempts, including failures).

When another attempt is needed, the decorator yields `RUNNING` before starting it,
even if transition budget remains. This lets reactive ancestors recheck guards
between attempts, including infinite loops. Smaller budgets and debugger steps
can split one attempt across drives. Paused ticks never start a new attempt.

## Timed decorators

`delay({ id, child, ms, reactive? })` waits before entering its child, once per
activation, then preserves the child's result and output. `delay` with zero
milliseconds enters immediately. While waiting, its snapshot reports `waitingOn:
'timer'`. Interrupting the delay disposes its timer without starting the child.

`timeout({ id, child, ms, reactive? })` starts its timer just before entering the
child. If it expires, the next engine transition cancels the active subtree with
reason `'timeout'` and returns `FAILURE` with no output. Zero milliseconds fails
without starting the child. Normal child completion preserves its result/output
and disposes the timer.

An expired timeout on the active stack takes precedence over the next child
transition, including a queued continuation. A direct child result already
processed by the engine wins even if the wrapper has not returned it yet.
Outermost expired timeouts win ties. Timeouts do not interrupt synchronous user
callbacks; timeout handling is itself one engine transition. A retained branch
is checked when traversal reaches it, so reactive guards can still preempt it.

`cooldown({ id, child, ms, reactive? })` allows its first entry immediately. When
its child completes with either success or failure, the cooldown period begins.
Reentry during that period returns `FAILURE` with no output, allowing a selector
to choose a fallback. It never interrupts a retained running child. An interrupted
or errored child does not start a cooldown; zero milliseconds disables the gate.
Cooldown state is keyed by definition within each runner and survives activation
completion. Different runners never share cooldown state. All cooldown timers
are disposed when the root completes, errors, or is cancelled.

```js
import { action, delay, timeout, cooldown } from './dist/index.js';

const guardedRequest = cooldown({ id: 'rate-limit', ms: 1000, child:
  timeout({ id: 'deadline', ms: 500, child:
    delay({ id: 'settle', ms: 25, child:
      action({ id: 'request', enter: c => c.wait.promise(c.services.request(),
        { resume: 'done' }), resume: { done: (c, value) => c.success(value) } })
    })
  })
});
```

Durations must be finite, nonnegative milliseconds. These decorators use the same
injected `clock.setTimeout`/`clearTimeout` as action waits. Pausing stops execution,
not clock time: timers may expire while paused, and the next step or continued tick
processes that state. Timer callbacks only mark readiness; they never execute a
child or cancel work directly. Supply a simulation clock to control elapsed time.
Errors, including cleanup errors, remain execution errors.

## Reactivity

Every node accepts `reactive: true | false | 'inherited'`. The default is
`'inherited'`; the root inherits `false`.

- `true`: a sequence or selector starts traversal at its first child on each logical tick.
- `false`: it resumes from its saved running child.
- `'inherited'`: it uses its parent's effective setting. An explicit setting overrides it.

Reactivity changes only traversal position. If traversal reaches the same running
child, that activation keeps its locals, input, descendant progress, and registered
waits. A child with `reactive: false` retains its own position even under a reactive
parent. Actions have no child traversal to rewind; reactivity does not rerun an
action's `enter` function. Completed actions are evaluated as fresh activations when
revisited, so put repeatable guards before running work in reactive sequences.

If an earlier sequence child fails or returns `RUNNING`, or an earlier selector
child succeeds or returns `RUNNING`, any previously running branch that
is no longer reached is halted child-first. Its waits are disposed, queued resumptions
discarded, and started actions receive `cancel(ctx, 'interrupted')` once. Late
notifications are ignored. Cleanup failures produce an `errored` runner after the
remaining cleanup is attempted. Existing inputs stay fixed for a retained activation;
new activations evaluate their input binding again.

```js
import { action, sequence, RUNNING, SUCCESS, FAILURE } from './dist/index.js';

const guardedWork = sequence({
  id: 'guarded-work', reactive: true,
  steps: [
    { node: action({ id: 'allowed', tick: c => c.services.allowed() ? SUCCESS : FAILURE }) },
    { node: action({ id: 'work', reactive: false, tick(c) {
      c.local.count = (c.local.count ?? 0) + 1;
      return c.local.count < 3 ? RUNNING : SUCCESS;
    } }) }
  ]
});

```

A logical tick ends when traversal returns `RUNNING` or a terminal result. Debugger
steps and exhausted transition budgets continue an unfinished traversal, so they do
not keep rewinding guards before reaching their running child. Pause does
not start a new traversal. Terminal roots remain terminal until a new runner is created.
Snapshots include each live frame's configured `reactive`, `effectiveReactive`, and
`onTraversal` flag, including retained branches while earlier guards are being checked.

## Timer and event waits

```js
const task = action({
  id: 'wait-for-message',
  enter: ctx => ctx.wait.timer(250, { resume: 'listen' }),
  resume: {
    listen: ctx => ctx.wait.event(emit => {
      const listener = event => emit(event.detail);
      source.addEventListener('message', listener);
      return () => source.removeEventListener('message', listener);
    }, { resume: 'received' }),
    received: (ctx, message) => ctx.success(message)
  }
});
```

Here `source` is an application-owned EventTarget. `wait.event(subscribe, options)`
also adapts Node emitters, game events, or callbacks: subscribe receives an `emit`
function and must return an unsubscribe function. Only the first emission is queued.
The engine unsubscribes before invoking the continuation, or during cancellation.
While paused, a settled subscription stays attached until resumed or cancelled but
further emissions are ignored. Subscription setup that throws must release any
resources it acquired before throwing.

`wait.timer(ms, { resume, value })` queues the named continuation with the optional
value. Delays must be finite and nonnegative. Timers use host elapsed time and keep
running while the tree is paused; their completions wait in the resume queue.
Polling `tick()` does not advance time or install a new timer. The host must call
`tick()` to consume ready completions; the runner does not start an execution loop.

For deterministic tests or a custom host, pass `clock: { setTimeout, clearTimeout }`
to `createRunner`. The default clock delegates to standard host timers. Snapshots
expose `waitingOn` as `promise`, `timer`, or `event` for active waits.

## Polling and combined waits

`ctx.wait.poll(predicate, { resume })` checks a synchronous predicate at most once
per drive of its active registration (`tick()` or `step()`). Falsy values keep waiting;
the first truthy value becomes the continuation input. Paused ticks do not poll.

```js
return ctx.wait.any([
  ctx.wait.event(subscribeToSignal),
  ctx.wait.timer(5000, { value: 'timeout' })
], { resume: 'winner', reject: 'failed' });
```

`any` returns `{ index, value }` for the first notification. `all` returns an array
in declaration order once every child resolves. Both fail fast on rejection, invoking
the group's `reject` handler or putting the runner in `errored` if none is specified.
Only the outer group's named handlers are used; child descriptors need no handlers.
Groups can nest and must be nonempty. Registration follows declaration order;
synchronous winners can prevent later sources from being installed. Polls run in
declaration order when the engine checks the active wait.

All registrations are disposed at the execution boundary that consumes the result,
or on cancellation. While paused, losing sources may still run, but cannot replace
the settled result. Promise disposal ignores completion; stopping the external
operation still requires application cancellation. Wait setup failures roll back
previously installed child subscriptions. Snapshots also report `poll`, `any`, or
`all` as waiting reasons.

Not implemented yet: remaining node/resume types, blackboards, JSON/YAML documents,
configuration and extensions, debugger controller/UI, recordings/checkpoints,
standalone bundles or environment adapters. The engine uses standard host timers by default and no DOM or game
globals. The browser example is validated in headless Chrome; Adventure Land integration remains unvalidated.
