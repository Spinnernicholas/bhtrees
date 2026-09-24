# BHTrees

Dependency-free JavaScript behavior trees for Node, browsers, and Adventure Land.
Development has started with the first engine slice; see [PLAN.md](PLAN.md) for the
full roadmap. The API is experimental.

```js
import { action, createRunner } from './src/index.js';

const tree = action({
  id: 'hello',
  enter: ctx => ctx.success(`Hello, ${ctx.input.name}!`)
});
const runner = createRunner(tree, { input: { name: 'world' } });
console.log(runner.tick().output);
```

Run `npm test` for the Node built-in test suite and `npm run example` for a sequence
with sibling data bindings. No install step or third-party packages are required.

## Browser playground

Run `npm run example:browser`, then open **http://127.0.0.1:8080** in a modern browser.
The server binds to localhost only. Set `PORT` to use another port. Use the HTTP
server instead of opening the HTML as a local file, so ES-module imports work.

Click **Start / restart** to launch a rover on three crystal-recovery expeditions.
Each expedition scans for the nearest deposit, travels to it, charges a drill,
collects a crystal, returns to base, and deposits its cargo. **Send radar ping**
skips the scan delay. The world shows movement, remaining deposits, cargo, and deliveries.
Pause freezes simulated movement while timers continue settling into the resume queue.
Step advances the tree one transition; movement resumes with Continue.

**Blocks** (default) displays nested sequences with flush sibling seams and interlocking
connector tabs. **List** gives an indented alternative. Select a node to inspect its
activation. Both retain the dark/slate palette and mint active indicators. These are
execution views, not a drag-and-drop editor. Resource counters expose cleanup;
the last 100 UI observations appear in event history.

This is an initial list/block debugger example, not the full debugger controller or
renderer plugin API. Node and headless Chrome checks cover its execution controls,
connected block geometry, the complete agent mission, restart, and cancellation. To rerun the real
browser smoke test, use `node scripts/check-browser.js <path-to-Chrome-or-Edge>`.

Implemented: immutable action/sequence definitions, isolated runner frames, explicit
inputs/outputs and sequence bindings, local activation state, promise/timer/event/poll waits with named
resume handlers, cancellation, bounded ticks, snapshots, and single-transition stepping.

`tick()` runs until completion, a wait, or its step budget. Promise settlement only
queues a continuation; call `tick()` again to process it. Terminal runners do not
restart. `pause()` prevents normal ticks; `step()` pauses and performs one engine
transition. `continue()` allows subsequent ticks. User callbacks run synchronously
and cannot be interrupted midway. Exceptions produce `errored`, separately from
behavior `FAILURE`. Cancellation disposes active actions in child-first order;
external operations must be stopped by the action's cancel hook.

Inputs, outputs, and application values are immutable by contract, not deeply copied.
Snapshots freeze their structural containers but are not historical deep snapshots.
Services are injected live APIs. Each runner owns its execution locals and scopes.

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
declarations, standalone bundles, or environment adapters. The engine uses standard host timers by default and no DOM or game
globals. The browser example is validated in headless Chrome; Adventure Land integration remains unvalidated.
