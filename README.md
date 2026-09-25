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

The playground fetches `examples/browser/mission.json` at startup. The **Mission
format** selector switches to `mission.yaml` by reloading with `?format=yaml`;
switching starts a fresh mission. Both files define the same initial mission,
but edits are independent. Its nested
example format keeps children and editable labels together; `mission-loader.js`
translates it into the library's standard tree document using the registry in
`game.js`. See the [editing guide](examples/browser/README.md).
The JSON defines sequences, action references,
and input bindings; JavaScript implements movement, scanning, mining, and unloading.
Edit the JSON and reload the page to change the tree. Controls remain disabled while
loading, and fetch/validation failures appear in the status and event history.
Reset rebuilds a fresh world and tree from the document already loaded.

Click **Start** to launch a rover that repeats crystal-recovery expeditions until all crystals are delivered; **Reset** returns it to idle.
The JSON uses one reusable expedition under an unbounded repeat, guarded by a
crystals-remaining condition. When the guard fails, a selector verifies that all
crystals are harvested and no cargo remains before reporting success.
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
`input`, `local`, `services`, and optional `blackboard`; return `true` for `SUCCESS` or `false` for `FAILURE`.
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

## Subtree calls

`subtree({ id, child, input?, output?, reactive? })` invokes an existing definition
without copying it. Give each call site its own ID and reuse the same `child`
object. Each invocation gets fresh activation locals and composite scopes;
concurrent runners also keep separate execution state. Inputs/outputs remain
immutable by contract, not deep copies. Services remain runner-wide, and cooldowns
inside a shared definition retain their documented per-definition, per-runner scope.

`input(scope)` runs once when entering the child; by default the call passes its
own input through. Retained running/waiting calls keep that captured child input.
`output(scope, result)` runs for either success or failure and maps only output;
the child status is preserved. `scope.input` is the call's original input and
`scope.last` is the child's output. `result` is a frozen completion wrapper with
`status` and `output`. The default mapper returns `scope.last`. Child-private
variables never merge into the caller's scope; bindings explicitly carry data
across the boundary. Binding exceptions become execution errors.

```js
import { action, sequence, subtree } from './dist/index.js';

const double = action({ id: 'double', tick: c => c.success(c.input * 2) });
const calls = sequence({ id: 'calls', steps: [
  { node: subtree({ id: 'first-call', child: double, input: () => 2 }), save: 'first' },
  { node: subtree({ id: 'second-call', child: double, input: () => 3 }), save: 'second' }
], output: scope => scope.vars });
```

Subtree calls follow normal reactivity inheritance and cancellation rules; input
mapping, child execution, and completion mapping run at engine boundaries. Recursive
cycles are rejected. Different definition objects cannot reuse an ID within a tree.
Snapshots expose `parentActivationId` (`null` at the root) so repeated definition
references can be distinguished by activation ancestry. Browser rows use that
ancestry to match live status; selection is still definition-based.

## Parallel branches

`parallel({ id, steps, successThreshold, failureThreshold, output?, reactive? })`
keeps multiple branches active. Both thresholds are required positive integers
no greater than the nonempty child count; their sum must be at most child count
plus one, ensuring that every possible set of completed results reaches a threshold.
For all-success behavior use `successThreshold: steps.length, failureThreshold: 1`;
for first-success behavior use `successThreshold: 1, failureThreshold: steps.length`.

Branches are visited in declaration order until they finish, wait, or yield.
The engine then visits the next unfinished branch; once the pass is finished,
execution yields until another drive. Completed branches never restart within
that parallel activation. `reactive` controls inheritance into descendants and
does not reset completed results. A transition budget can split a pass across
ticks/steps without restarting it, and all branches share the runner's step budget.
This is cooperative concurrency: user callbacks still run synchronously.

The first threshold reached by processed child completions wins immediately.
Even when callbacks arrive in another order, branch visitation order determines
which result the engine processes first. Later children may never start if an
earlier child reaches a threshold. Remaining active branches are cancelled with
reason `'parallel-complete'`, in declaration order and child-first within each
branch, before the output reducer runs. Cleanup failures, branch exceptions, and
reducer exceptions remain execution errors; they do not count as child failures.

Each step accepts an `input(scope)` binding, captured once on branch entry. Its
scope contains the parallel input, an empty frozen `vars`, and undefined `last`;
branches cannot read sibling outputs implicitly. Child locals and composite scopes
are isolated. Application object inputs/services remain shared by contract.
`save` bindings are rejected: use an explicit `output(results, status)` reducer.

`results` is a frozen array in declaration order. Entries are frozen completion
wrappers (`status`, `output`), or `undefined` for unfinished/unvisited branches.
The default reducer returns that array, preserving both success and failure data.
Live parallel snapshots expose `parallelResults` with the same shape.

```js
import { parallel, action } from './dist/index.js';

const requests = parallel({ id: 'requests', successThreshold: 2, failureThreshold: 1,
  steps: ['profile', 'settings'].map(name => ({ node: action({ id: name,
    enter: c => c.wait.promise(c.services.load(name), { resume: 'loaded' }),
    resume: { loaded: (c, value) => c.success(value) }
  }) })),
  output: results => results.map(result => result?.output)
});
```

Snapshots also identify `parentChildIndex` (`null` at the root), distinguishing
multiple occurrences of the same definition under one parent. Browser rows match
both ancestry and child position. Concurrent completions of a shared cooldown
definition refresh its single runner-local cooldown timer.

## Optional blackboards

`createBlackboard(initial?)` creates caller-owned observable state. Inject it with
`createRunner(tree, { blackboard })`; actions (including resume/cancel handlers)
and conditions receive it as `ctx.blackboard`. Omit the option to disable it:
ordinary inputs, outputs, and local scopes work unchanged. Create a board per
runner for isolation, or pass the same board explicitly to share state. Subtrees
and parallel branches inherit that runner's board. Runners never dispose boards
or their subscribers, including on cancellation or terminal completion.

```js
import { createBlackboard, createRunner, condition } from './dist/index.js';

const blackboard = createBlackboard({ ready: false });
const unsubscribe = blackboard.subscribe(change => console.log(change));
const tree = condition({ id: 'ready', test: c => c.blackboard.get('ready') });
blackboard.set('ready', true);
const runner = createRunner(tree, { blackboard });
console.log(runner.tick().status); // SUCCESS
unsubscribe();
```

Boards expose `get`, `has`, `set`, `delete`, `subscribe`, `snapshot`, and `revision`.
Keys are strings; `has` distinguishes absent keys from stored `undefined` values.
Initial state is copied from own enumerable string properties of a plain record.
`delete` reports whether a key existed. Setting an existing key to the same value
according to `Object.is`, or deleting an absent key, does not emit a change.

Subscriptions receive frozen `{ revision, type, key, hadValue, previous, value }`
records for changes after subscription, without an initial event. Revisions start
at zero and increment once per change. Notifications are synchronous, in subscription
order; writes from listeners queue their notifications so observers receive revisions
in order. A listener's live reads may already reflect a later reentrant write: use
the event's values to inspect that specific change. Unsubscribe functions are
idempotent, and duplicate subscriptions are independently disposable. New listeners
join subsequent events; removing a listener prevents further delivery to it.

Subscriber exceptions are collected while notifying the remaining listeners, then
reported as an `AggregateError`. Writes are already committed and are not rolled
back. If an action's write triggers such an error, normal runner error handling
applies. Notifications cannot reenter an executing runner.

`board.snapshot()` returns a frozen `{ revision, values }` container; runner
snapshots include it as `blackboard`. Older snapshots retain top-level values,
but application object values are not cloned or frozen. Arbitrary nested mutation
is not observable: replace a value through `set` to notify observers. No unbounded
history is retained. External writes are allowed while execution is paused; tree
evaluation resumes only on step/continue. The full debugger watchpoint controller
remains planned.

## Declarative path bindings

Input and output bindings accept either their existing function or a plain data
descriptor: `{ path: ['vars', 'target', 'position'] }`. Paths are arrays of literal
string keys and nonnegative safe-integer indices. They can be represented directly
in JSON/YAML; they are never JavaScript expressions. This supplies portable binding
data and can be used with the JSON tree document APIs below.

```js
const trip = sequence({ id: 'trip', steps: [
  { node: findTarget, save: 'target' },
  { node: move, input: { path: ['vars', 'target', 'position'] }, save: 'arrival' }
], output: { path: ['vars', 'arrival'] } });
```

| Binding location | Path root |
| --- | --- |
| Sequence/selector/parallel step input | `{ input, vars, last }` (parallel vars are empty) |
| Sequence/selector output | `{ input, vars, last }` |
| Subtree input | `{ input, vars, last }` for the call |
| Subtree output | `{ input, vars, last, result }`, with `result.status` and `result.output` |
| Parallel output | `{ results, status }`, results in declaration order |

For example, a parallel output path `['results', 0, 'output']` selects its first
branch's output. An empty path returns the whole root. A key containing a dot is
literal: `['input', 'a.b']` differs from `['input', 'a', 'b']`.

Lookup visits own data properties on objects/arrays only. Missing properties or
null/primitive intermediates return `undefined`; inherited properties are not
visible. Accessor properties produce an execution error without invoking the getter.
Bindings cannot call functions, perform arithmetic, or invoke methods; keep function
bindings for those operations. Object values retain their normal ownership rules.
Constructors copy and freeze path descriptors and segment arrays. Unknown descriptor
fields and invalid segments fail validation. Input paths follow the same capture
rules as functions: a retained child keeps its original input.

Default composite output mappings are now declarative (`['last']` for sequences,
selectors, and subtree calls; `['results']` for parallel nodes). Existing function
bindings keep their original arguments and behavior.

## Portable JSON trees

`createRegistry()` associates implementation names with code. Use
`registerAction(name, implementation, version = 1)` or
`registerCondition(name, test, version = 1)`. Registrations belong to that registry;
name collisions are rejected across both kinds. Actions include their enter/tick,
resume, and cancel functions. Register the same function references used to construct
the tree; export matches all action callbacks, not only the entry callback. If code
is registered under multiple names, export selects the first matching registration.

```js
import { action, createRegistry, encodeTree, decodeTree, createRunner } from './dist/index.js';

const registry = createRegistry();
const implementation = { tick: ctx => ctx.success(`Hello, ${ctx.input}!`) };
registry.registerAction('app.greet', implementation, 1);
const tree = action({ id: 'greet', ...implementation });
const text = encodeTree(tree, { registry });
const restored = decodeTree(text, { registry });
console.log(createRunner(restored, { input: 'world' }).tick().output);
```

`encodeTree`/`decodeTree` handle JSON text; `toTreeDocument`/`fromTreeDocument`
handle canonical objects. Documents use `{ format: 'bhtrees', version: 1,
kind: 'tree', root, nodes }`. `root`, child links, and step links reference node IDs
in the flat `nodes` array, preserving shared definition identity after decoding.
Each action/condition record includes `implementation` and `implementationVersion`.
Built-in structural node options and declarative path bindings round-trip directly.
Infinite retry/repeat limits use the document string `'unbounded'`.

These APIs capture definitions only. Runtime inputs, blackboards, services, waits,
and execution frames are supplied separately. They never serialize function source
or run action/condition callbacks during decoding. Unregistered leaf implementations
and function bindings fail strict export. Use declarative bindings for portable
input/output mappings.

`DocumentError` includes a `path` such as `$.nodes[0].steps[1].input`. Unknown fields,
unsupported types/versions, invalid options, missing references, duplicate IDs,
cycles, and unreachable definitions fail validation. Implementation versions must
match exactly for `registerAction`/`registerCondition`; custom factories support the
explicit data migrations described below. Limits are 10,000 nodes,
128 child-reference edges in a path, and 1,000,000 characters for JSON text. JSON
parsing uses the platform parser. Select `{ codec: 'yaml' }` for the owned YAML
codec described below; JSON remains the default.

Run `npm run build`, then `node examples/documents.js` for a complete example.
Tree documents support registered action/condition implementations and custom
factories with data migrations. Configuration documents are supported as described
below; checkpoints and recordings remain planned.

## Configuration documents and loading

`toConfigDocument(config)` / `fromConfigDocument(document)` use the version-1
`{ format: 'bhtrees', version: 1, kind: 'config', config }` envelope.
`encodeConfig` / `decodeConfig` support `{ codec: 'json' | 'yaml' }`, defaulting
to JSON. Tree documents can also contain `config` and one `configFile` reference.
Pass these fields to `encodeTree` / `toTreeDocument` options when authoring trees.
Decoded definitions retain this metadata on re-export; explicit export options
replace the corresponding stored field. Ordinary `decodeTree` and `createRunner`
do not resolve or apply document configuration.

Use `await loadConfiguredTree(text, options)` to resolve configuration and create
a tree with a configured runner factory:

```js
const loaded = await loadConfiguredTree(treeText, {
  registry,
  codec: 'yaml',
  baseURI: 'https://example.test/bots/mission.yaml',
  readConfig: async uri => {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`Config request failed: ${response.status}`);
    return { text: await response.text(), codec: 'yaml' };
  },
  config: { blackboard: { enabled: true } },
  overrides: { runtime: { maxStepsPerTick: 100 } }
});
const runner = loaded.createRunner({ input: { name: 'Scout' }, services });
console.log(loaded.config, loaded.provenance);
runner.tick();
```

Precedence, low to high: library defaults, referenced config file, embedded tree
config, explicit `options.config`, and `options.overrides`. Objects merge recursively;
arrays replace except `extensions`, which merges by identity as described below.
Empty objects do not clear inherited data. Null is an ordinary value
inside blackboard initial data, not a deletion marker. Every layer is validated,
even if a later layer overrides it. `resolveConfiguration([{ config, source }, ...])`
also exposes merging directly for application-defined layers.

Supported settings in this first configuration slice:

| Setting | Default | Validation |
| --- | --- | --- |
| `runtime.maxStepsPerTick` | `1000` | Positive safe integer |
| `runtime.errorPolicy` | `'stop'` | Only `'stop'` is implemented |
| `blackboard.enabled` | `false` | Boolean |
| `blackboard.initial` | `{}` | Plain record of portable JSON-shaped data |
| `extensions` | `[]` | Validated declarations; module loading remains planned |

All settings apply when creating a new runner; live reconfiguration is not
implemented. `loaded.createRunner()` uses the resolved step budget and creates a
fresh, deeply copied blackboard per call when enabled. Disabled blackboards are
absent even if initial data was supplied. Inputs, services, and clock remain runner
arguments. Change the budget/blackboard through configuration overrides so the
reported provenance stays accurate; use the ordinary runner API for explicitly
shared caller-owned blackboards.

`loaded.config` and `loaded.provenance` are deeply frozen. Provenance keys are JSON
Pointers to effective leaves, with an array or empty object treated as one leaf.
Each value contains `layer` (`defaults`, `file`, `embedded`, `explicit`, or
`overrides`) and, for file/embedded data where available, the declaring `uri`.
Plain data is copied without invoking getters. Cycles, unsupported values, unknown
settings, and invalid envelopes produce `DocumentError` paths. Limits are 128
levels and 100,000 values in initial data, 128 user layers, and 1,000,000 characters
per encoded/decoded document.

Relative `configFile` references require an absolute `baseURI` for the tree.
Paths resolve against that URI, never the working directory. Use `file:` URLs for
filesystem paths, including Windows paths. The loader calls the injected
`readConfig(uri)` exactly once and expects `{ text, codec }`; it performs no implicit
fetch or filesystem access. The host owns access policy and chooses the referenced
file's codec. Read/decode errors include the resolved URI. Referenced config files
cannot themselves contain `configFile`. Structural tree validation and validation
of caller-supplied configuration precede I/O; factories run after configuration
resolution. Explicit layers are copied before awaiting the host reader.

Debugger settings, live reconfiguration, and custom-value envelopes in configuration
remain planned. Run `npm run build`, then
`node examples/configuration.js` for file-relative YAML loading and isolated runners.

## Extension declarations and configuration resolution

Configuration accepts an `extensions` array. Every declaration needs exactly one
of `name` or `path`, plus optional `id`, `enabled`, and `options` (a plain data record).
Names are catalog identifiers; paths are URI references. This slice resolves and
merges declarations without importing modules, looking up names, or running setup.

```yaml
extensions:
  - name: metrics
    options:
      counters: [ticks, waits]
  - id: combat
    path: ./plugins/combat.js
    enabled: false
    options:
      retreatHealth: 0.25
```

The merge ID defaults to `name`, or to the resolved absolute URI for a path
declaration. Explicit IDs remain stable across sources. Each path is resolved
against its own declaring source before merging: a referenced config uses that
file's URI; embedded config uses the tree's `baseURI`. Explicit config and overrides
use `configBaseURI` and `overridesBaseURI`, respectively, falling back to the tree's
`baseURI`. Direct `resolveConfiguration` layers use `source.uri`. Relative paths
without a declaring URI fail, including disabled declarations. Use absolute `file:`
URLs for filesystem paths; native path handling belongs to future host adapters.

Declarations with the same ID merge in precedence order, retaining the first
declaration's position. New IDs append. Options merge recursively, option arrays
replace, and omitted `enabled` preserves an inherited setting. New declarations
default to `enabled: true` and `options: {}`. An empty extension list leaves inherited
entries intact; disable an entry using its name/path and `enabled: false`.
ID-only overrides are not accepted. The same ID must continue to identify the same
name or resolved URI; attempts to retarget an ID fail. Duplicate IDs in one source,
including path spellings that resolve to the same URI, also fail. Different IDs
may still refer to one eventual manifest; checking manifest identity is future work.

Resolved `config.extensions` includes required IDs, enabled flags, options, and
absolute paths. The entire result is frozen. Provenance uses stable array positions,
such as `/extensions/0/path` and `/extensions/0/options/retreatHealth`, and tracks
each field's effective source. Repeated source fields update their provenance;
inherited options keep theirs. Implicit enabled/options defaults are labeled
`defaults`. Limits are 1,000 declarations per source and 1,000 resolved extensions;
the declaration array and its options share the 100,000-value / 128-level bound.

`await resolveTreeConfiguration(text, options)` applies the same config-file loading
and precedence as `loadConfiguredTree`, returning `{ config, provenance }` without
constructing nodes or executing factories. Structural tree validation still requires
its implementations in the supplied registry. Use this API to inspect enabled
extension declarations. `loadConfiguredTree` currently rejects enabled extensions
before factory calls, since module loading and lifecycle are not implemented; it can
create runners when all declarations are disabled. Neither API fetches extension
modules. Names and option schemas will be checked by the future manifest loader.

Run `npm run build`, then `node examples/extension-config.js` for source-relative
path resolution, option merging, disabling, and provenance.

## YAML application profile

`encodeTree`/`decodeTree` and `encodeValue`/`decodeValue` accept
`{ codec: 'yaml', registry }`. They use the same canonical documents and portable
value envelopes as JSON. Choose the codec explicitly; input is not autodetected.
`parseYaml(text)` and `stringifyYaml(value)` are also available for plain data.
Run `npm run build`, then `node examples/documents.js` for both tree formats.

The dependency-free parser implements a **limited YAML 1.2 application profile**,
not full YAML conformance. It supports block mappings/sequences (including compact
sequence entries), single-line flow collections, comments, single-line quoted/plain
scalars, and literal/folded block strings (`|`, `>`, with `-`/`+` chomping).
Optional `---` and `...` markers must occupy their own lines. Only one document is
accepted. Input may use LF, CRLF, CR, and an initial BOM.

Mappings require string keys and decode to null-prototype records. Quote keys such
as `"true"` or `"42"` to prevent scalar resolution. Empty values and `null`/`Null`/
`NULL`/`~` become null; the three conventional case forms of true/false become
booleans. Decimal/exponent numbers and unsigned `0x`/`0o` numbers become JavaScript
numbers. Dates and words such as `yes` and `on` stay strings. Nonfinite numbers and
negative zero are rejected. Double quotes accept YAML escapes, including Unicode;
single quotes escape an apostrophe by doubling it.

This first profile rejects anchors/aliases, tags, merge keys, directives, complex
or non-string keys, indentless sequences, explicit block indentation indicators,
multiline flow collections, and multiline plain/quoted scalars. Use `|` or `>` for
multiline text. Duplicate keys, invalid indentation, and unsupported syntax produce
`YamlError` with one-based `line` and `column`. Subsequent canonical document/value
validation still uses `DocumentError` field paths.

The writer emits block YAML and quotes every string/key, escaping multiline strings
inside double quotes. It preserves supported data values, not comments, source style,
object identity, or prototypes. It rejects cycles, getters, sparse arrays, extra
array properties, symbols, functions, undefined, and unregistered class instances;
use the portable value APIs and codecs for custom application types. Limits are
1,000,000 text characters, 128 nesting levels, and 100,000 visited values (including
mapping keys). The parser/writer have no Node or browser dependencies.

The profile follows the [YAML 1.2.2 specification](https://yaml.org/spec/1.2.2/).
Tests include project fixtures and a small licensed, pinned selection from the
[YAML test suite](https://github.com/yaml/yaml-test-suite); unsupported-profile
cases are tested as explicit rejections, not counted as full conformance.

## Custom values and migrations

`registry.registerValue(name, { version, test, encode, decode, migrations? })`
registers a synchronous value codec. `test` identifies the application type, `encode`
returns a portable payload, and `decode` reconstructs the application value.
Decoded results must pass the same predicate. In TypeScript, `test` is a type guard;
`encode` and `decode` then use that application type. Value names have a separate
namespace from action/condition names and must be unique within their registry.
The first matching codec in registration order handles export.

```js
registry.registerValue('app.date', {
  version: 2,
  test: value => value instanceof Date,
  encode: date => date.toISOString(),
  decode: data => {
    if (typeof data !== 'string') throw new TypeError('Expected date string');
    const date = new Date(data);
    if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid date');
    return date;
  },
  migrations: { 1: milliseconds => new Date(milliseconds).toISOString() }
});
```

`toPortableValue`/`fromPortableValue` convert values and canonical envelopes;
`encodeValue`/`decodeValue` convert values and JSON text. Supply `{ registry }`
as the second argument. Custom envelopes contain
`{ kind: 'custom', type, version, data }`. Arrays use `{ kind: 'array', items }`,
and records use `{ kind: 'object', entries: [[key, value], ...] }`. Every container
is wrapped, so an ordinary object's keys cannot impersonate a custom envelope.
Nested custom types are supported. These standalone value APIs do not automatically
capture tree inputs, blackboards, or runner state.

A migration keyed by version `n` converts its decoded payload from version `n` to
`n + 1`. Decode checks that every required step exists, decodes the payload, runs
those migrations in order, then calls the current decoder. Future versions and
missing migration steps fail with `DocumentError`. Codec and migration exceptions
include the affected field path. Registration copies the callback table; changing
the supplied registration object later does not change the registry.

Unregistered values support null, booleans, strings, finite numbers except negative
zero, dense arrays, and plain records. Functions, undefined, symbols, bigint,
nonfinite numbers, negative zero, and class instances require an explicit suitable
codec or fail export. Accessors, symbol keys, sparse arrays, extra array properties,
and cycles are rejected. Repeated acyclic references are copied, not preserved.
Decoded records have null prototypes, allowing keys such as `__proto__` safely.
Property descriptors/prototypes are not preserved. Codec payloads must eventually
reduce to supported values; a codec cannot encode a value as itself.

Limits are 128 nesting levels, 100,000 visited values, 128 migration steps per
custom value, and 1,000,000 characters for JSON text.

## Custom node factories

`registry.registerNode(name, { version, create, migrations? })` registers a
synchronous factory that builds an existing runtime node from portable data and
explicit children. Use `registry.createNode(name, { id, reactive?, data, children? })`
for code-authored definitions that retain their factory identity on export.
Factory names share a namespace with action and condition implementations.

```js
const registry = createRegistry();
registry.registerNode('app.constant', {
  version: 2,
  migrations: { 1: value => ({ value }) },
  create({ id, reactive, data }) {
    if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'value')) {
      throw new TypeError('Expected an object with value');
    }
    return action({ id, reactive, tick: ctx => ctx.success(data.value) });
  }
});
const tree = registry.createNode('app.constant', {
  id: 'answer', data: { value: 42 }
});
const restored = decodeTree(encodeTree(tree, { registry }), { registry });
console.log(createRunner(restored).tick().output); // 42
```

Factories receive `{ id, reactive, data, children }`. The options and child array
are frozen; data is copied through the portable value codecs, including registered
custom value types. Validate the application's data shape in `create`. Return a
built-in action, condition, composite, or decorator preserving the supplied ID,
reactivity, and direct child references in order. For example, a sequence factory
can map `children` to steps and derive bindings from `data`. Internal execution
callbacks and function bindings are supplied by the factory's code. Factories
cannot introduce new engine node types or hide additional child definitions.

Documents store `type: 'custom'`, `implementation`, `implementationVersion`,
portable `data`, and a `children` array of node IDs. Shared references remain shared.
Export uses captured data and does not rerun factories or value codecs. Export a
custom definition with the registry that created it; copying/spreading the definition
does not preserve factory identity. Treat factory data and captured values as immutable.

On import, graph/structural validation precedes factory calls. Value decoding and
node data migrations then run before each factory, children first. A migration keyed
by `n` upgrades data from version `n` to `n + 1`; it cannot change child references,
IDs, or reactivity. Export writes the current version and migrated data. Future
versions, missing migration steps, more than 128 steps, invalid results, and callback
errors fail with `DocumentError` paths. Registration copies the migration table.
Factories, migrations, and codecs must be synchronous, deterministic construction
functions without external side effects: a later payload/factory error can still
abort the import, and these callbacks have no rollback lifecycle. Action/condition
execution callbacks run only when the runner executes.

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

## Callback-token waits

`ctx.wait.callback({ resume, reject? })` returns a frozen handle with `wait`,
`resolve(value)`, and `reject(error)`. Return `token.wait` from the action and pass
the settlement methods to external code. `resolve` is also accepted as an alias
for `resume` in the options, as with other waits.

```js
const move = action({ id: 'move', enter(ctx) {
  const token = ctx.wait.callback({ resume: 'arrived', reject: 'failed' });
  ctx.services.moveTo(ctx.input, token.resolve, token.reject);
  return token.wait;
}, resume: {
  arrived: (ctx, position) => ctx.success(position),
  failed: (ctx, error) => ctx.failure(error)
}, cancel: ctx => ctx.services.stopMoving() });
```

Settlement returns `true` only for the first accepted call, and `false` for later
calls or calls after disposal. A callback may fire synchronously before the action
returns: the token stores its result until registration. Settlement only queues
a continuation; it never executes the handler inline. A synchronous settlement
can be consumed at a later transition in the same tick if budget permits. Pause
retains queued results. Rejection without a named rejection handler becomes an
execution error, without creating a rejected JavaScript promise.

Use `token.wait` inside `wait.any`/`wait.all`; group handlers govern the result as
with other child descriptors. Registered losing tokens are disposed when the
engine consumes the group's result. Cancellation and reactive interruption also
invalidate registered tokens. A token skipped by an already-settled group was
never registered and has no runner connection; it may still accept one settlement.
Invalidating a token does not stop its external operation: use the action's cancel
handler for that cleanup.

Each descriptor may be registered only once. Create fresh tokens inside `enter`
or a resume handler for new waits; do not put a token in a reusable definition.
Tokens are runtime handles and cannot be forged or copied into new descriptors.
Snapshots report `waitingOn: 'callback'` for direct callback waits.

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

Not implemented yet: full YAML syntax beyond the documented profile, debugger
configuration and extension loading, debugger controller/UI, recordings/checkpoints,
standalone bundles or environment adapters. The engine uses standard host timers by default and no DOM or game
globals. The browser example is validated in headless Chrome; Adventure Land integration remains unvalidated.
