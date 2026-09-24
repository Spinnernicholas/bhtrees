# BHTrees implementation plan

Status: development started. The engine supports synchronous boolean conditions, memory/reactive selectors, tick actions, promise/timer/event/poll waits, nested any/all groups, and an injectable timer clock. Nodes support tri-state reactive inheritance; sequences and selectors preserve reached running children and interrupt unreachable branches. The browser playground includes execution controls, tree inspection, event history, and a simulation clock. The core now uses strict TypeScript with generated ESM JavaScript and declarations; remaining Phase 2 nodes/blackboards remain pending. The playground is not yet the full debugger controller or renderer extension API. See README.md for capabilities and limitations.

## Goals

Build a JavaScript behavior tree library that runs in Node.js, browsers, and
Adventure Land, with no third-party dependencies in the library or bundled UI.
Use TypeScript for the core and compile to ESM JavaScript with generated TypeScript
declarations. TypeScript is a development-only dependency; use Node built-in tools
for runtime tests and host scripts. Examples and runtime tests remain JavaScript.

Required capabilities:

- Reusable tree definitions and isolated concurrent runner instances.
- Multiple running-node resume mechanisms and named continuation handlers.
- Optional blackboards plus explicit parent/child inputs, outputs, and local scope.
- A built-in debugger with interchangeable list, nested-block, and custom HTML UIs.
- JSON and YAML serialization/deserialization and custom codecs and value types.
- Configuration embedded in a tree or provided in a separate JSON/YAML document.
- Configuration-driven loading of built-in, installed, and path-based extensions.

Examples below describe proposed contracts, not existing APIs. Final names can
change during the first vertical slice; semantics should remain consistent.

## Architecture and project layout

```text
src/
  core/                  definitions, execution frames, results, scheduler
  nodes/                 composites, decorators, actions, conditions
  data/                  scopes, bindings, blackboard
  serialization/         canonical documents, registries, checkpoints
  codecs/                JSON and YAML parsers/writers
  config/                validation, merging, provenance
  extensions/            catalogs, resolution, dependency ordering, lifecycle
  debug/                 controller, protocol, recordings, transport contracts
  ui/                    common components, list renderer, blocks renderer
  adapters/              Node, browser, Adventure Land
test/                    unit, integration, conformance fixtures
examples/                runnable examples for all three environments
scripts/                 dependency-free test/build helpers
docs/                    public contracts and environment guides
dist/                    generated distribution artifacts
```

The core must not import Node modules or reference DOM or game globals. Inject
clock, scheduling, services, module resolution, and transports through host APIs.
Provide ESM entry points and a standalone global build exposing `BHTrees`.
The complete distribution includes both codecs and debugger renderers; allow
smaller explicit entry points without requiring users to install extra packages.
CommonJS packaging is optional and should not delay the primary environments.

## 1. Execution contracts

Separate immutable tree definitions from runners and activation frames. Definitions
have stable node IDs; every activation has a distinct activation ID and generation.
A shared subtree definition may have several simultaneous activations.

Behavior results are `SUCCESS`, `FAILURE`, and `RUNNING`. Track idle, waiting,
cancelled, and errored as execution lifecycle states. Exceptions are not ordinary
behavior failures unless an explicit error policy converts them.

Use an explicit execution stack and small engine transitions to support debugger
stepping. `runner.tick()` is synchronous and bounded by a configurable step budget.
Async completions enqueue work and never reenter an executing tree. The host can
drive ticks manually or install a scheduling adapter. Prevent overlapping ticks.
Define terminal-root restart behavior explicitly; default to remaining terminal
until reset or a new run, with repeat behavior available through a node or policy.

Each activation owns inputs, local state, outputs, child position, wait registrations,
and cleanup. Cancellation propagates through children and releases resources once.
Late completions from cancelled or superseded generations are ignored.

Standard nodes:

- Memory sequence and selector, preserving the active child.
- Reactive sequence and selector, reevaluating priorities and cancelling displaced work.
- Parallel with explicit success/failure thresholds and cancellation of remaining work.
- Actions, conditions, and subtree invocations.
- Inverter, force-success, force-failure, delay, timeout, cooldown, retry, and repeat.

Specify threshold conflicts, child visitation order, error propagation, and cancellation
order. Repeats and retries must yield when the step budget is exhausted.

### Resume mechanisms

Normalize polling, timers, promises, events, external callback tokens, and named
continuations into the same scheduler protocol. Support `wait.any` and `wait.all`.

```js
const travel = action({
  id: 'travel',
  enter(ctx) {
    return ctx.wait.promise(ctx.services.moveTo(ctx.input.destination), {
      resolve: 'arrived',
      reject: 'moveFailed'
    });
  },
  resume: {
    arrived(ctx, result) {
      return ctx.success({ position: result.position });
    },
    moveFailed(ctx, error) {
      return ctx.failure({ reason: error.message });
    }
  },
  cancel(ctx) {
    ctx.services.stopMoving();
  }
});
```

Each registration settles at most once. Queue order determines simultaneous winners;
`any` disposes losing registrations. Document `all` rejection behavior and output
ordering. Distinguish cancellation of a continuation from cancellation of its external
operation, which requires adapter support. Timers use elapsed time, not tick counts.
Record logical time separately from wall time so pause and timeout behavior is explicit.

## 2. Data flow

| Location | Contract |
| --- | --- |
| `ctx.input` | Parent-provided values captured at activation |
| `ctx.local` | Private state retained for that activation |
| Completion output | Explicit child-to-parent result, including failure output |
| Composite scope | Named child outputs available to subsequent children |
| `ctx.blackboard` | Optional injected shared state across activations |
| `ctx.services` | Live external APIs; not implicitly serialized |

Treat inputs and outputs as immutable by contract. Define ownership of object values
and use development-time checks where practical. Explicit bindings pass values down
and map results up. Successful child outputs can be saved to a composite-local name;
failure output propagation must be explicit. Parallel branches get isolated scopes
and explicit output reducers; reject ambiguous output collisions.

Blackboards expose get/set/delete, change subscriptions, and explicit scope ownership.
Debugger watchpoints and history track writes through these APIs. Arbitrary nested
mutation cannot be promised observable. Disabling the blackboard must not disable
ordinary input/output data flow.

Support function bindings for code-authored trees and declarative path bindings or
registered binding names for portable documents. Declarative paths are parsed data,
not JavaScript expressions evaluated with `eval`.

## 3. Debugger and HTML renderers

The debug controller owns execution controls, breakpoints, selection, recording, and
history position. Renderers own presentation, expansion, scrolling, and layout.
All built-in and custom UIs use the same public client and versioned protocol.

```js
const debug = createDebugger(runner);
const view = mountDebugger({ target, client: debug, renderer: 'blocks' });
view.setRenderer('list');
view.dispose();
```

Custom renderer contract:

```js
function customRenderer({ target, client }) {
  const unsubscribe = client.subscribe(snapshot => render(target, snapshot));
  return { dispose() { unsubscribe(); target.replaceChildren(); } };
}
```

Subscriptions deliver an initial snapshot immediately. Multiple views may attach to
one controller. Switching or disposing a view must not reset or stop the runner.
Expose definitions, activation snapshots, inspection, session state, capabilities,
commands, timeline queries, and import/export through the client. Commands validate
requests and return structured outcomes. Batch UI updates without dropping recorded
execution events. Remote clients support disconnect and snapshot resynchronization.

Built-in renderers:

- Accessible expandable list with statuses and breakpoint controls.
- Blockly-style nested HTML/CSS blocks, implemented without Blockly.
- Shared toolbar, inspector, timeline, and breakpoint panels usable by custom UIs.

Dragging blocks to author a tree is a separate future editor feature.

Debugger completion criteria:

- Live branches, statuses, waiting reasons, inputs, outputs, locals, and blackboards.
- Pause/continue; step into/over/out; advance one logical tick.
- Conditional entry/resume/completion/error breakpoints and write watchpoints.
- Searchable timeline, cancellation details, errors, and per-node profiling.
- Multiple runner selection and distinct definition/activation inspection.
- Bounded recordings, historical inspection, JSON/YAML export/import.
- Validated edits to supported state while paused, recorded as debug events.
- Extension status and resolved configuration with provenance.
- Local browser UI and a Node-hosted browser UI using built-in HTTP facilities.

Pause applies at engine boundaries, not inside arbitrary JavaScript user functions.
External work can finish while paused; completions queue for later execution.
Historical inspection does not undo game actions. Use explicit representations for
cycles, functions, truncated values, and unavailable historical data. Trace size,
snapshot frequency, and event retention must have bounded defaults.

## 4. Serialization and codecs

All codecs translate a versioned canonical document. Keep wire formats separate from
custom node construction and application value serialization.

Document kinds: `tree`, `config`, `checkpoint`, and `recording`. Each includes
`format: bhtrees`, a schema `version`, and `kind`. Node/value registrations have
their own type versions and migration hooks. Validate before instantiation and
report useful field paths. Reject unsupported future versions clearly.

```js
serialization.encode(tree, { kind: 'tree', codec: 'yaml' });
serialization.decode(text, { kind: 'tree', codec: 'yaml', registry });
serialization.registerCodec('custom', { encode, decode });
registry.registerNode('game.moveTo', { version: 1, create });
registry.registerValue('game.position', { version: 1, test, encode, decode });
```

Codecs return/accept strings or bytes according to their declared capabilities.
Use explicit type envelopes consistently across JSON and YAML. Do not serialize
executable function source. Inline functions require registered portable names or
cause strict export errors with the offending path.

Checkpoints contain frame state, scheduler descriptors, and named continuations,
not live promises or event subscriptions. Resumable operations supply restore hooks
that reconnect, explicitly restart, or reject restoration. Restarting side effects
is never implicit. First support checkpoints at engine boundaries, with a declared
capability check before capture. Recordings may contain descriptive placeholders;
tree and checkpoint export remain strict by default.

### Built-in JSON and YAML

Both formats must work without third-party dependencies in every target environment.
Own the YAML parser/writer as an isolated component; do not substitute JSON output
and call that human-readable YAML support.

Target YAML 1.2 syntax with an explicitly documented application data profile:
string mapping keys, portable scalar values, and one document per load. Support
block/flow collections, quoted/plain scalars, comments, multiline strings, and
document markers. Define anchor/alias handling and supported tags before release;
reject incompatible graphs or values explicitly. Custom application types use
portable envelopes rather than format-specific executable tags.

Reject duplicate keys, provide line/column errors, and bound parser depth and alias
expansion. Quote ambiguous strings on output. Guarantee semantic round trips, not
comment or source-format preservation. A partial implementation must identify its
supported subset and must not be advertised as full YAML conformance.

Reference: https://yaml.org/spec/1.2.2/

## 5. Configuration documents

Use the same configuration schema for embedded and separate configuration. Keep
runtime settings, feature switches, blackboard initialization, debugger settings,
and extension options in documented namespaces.

```yaml
format: bhtrees
version: 1
kind: tree
configFile: ./bot.config.yaml
config:
  runtime:
    maxStepsPerTick: 1000
    errorPolicy: stop
  blackboard:
    enabled: true
    initial:
      targetId: null
  debugger:
    enabled: true
    renderer: blocks
    recording:
      enabled: true
      maxEvents: 10000
  extensions:
    - name: adventure-land
      options:
        tickIntervalMs: 250
    - path: ./extensions/combat.js
root:
  type: game.main
```

Separate configuration:

```yaml
format: bhtrees
version: 1
kind: config
config:
  debugger:
    renderer: list
```

Precedence, lowest to highest:

1. Library defaults.
2. Configuration referenced by the tree's `configFile`.
3. Embedded tree configuration.
4. Explicit configuration supplied to the loader.
5. Programmatic overrides.

Objects merge recursively; arrays replace except the extension list, which merges
by declaration ID. `null` is a value only where allowed, not an implicit deletion.
An extension declaration may specify `id`; named declarations default their ID to
`name`. Path declarations without an ID use their canonical resolved source as
their merge identity. Recommend explicit IDs for overriding path extensions.
`enabled: false` disables an inherited extension. Reject duplicate IDs within one
source and conflicting identities after manifest loading.

Preserve value and extension-source provenance during merging. Resolve paths before
losing their declaring document's base location. Text supplied directly to the loader
must include a base URI when it contains relative references. Initially support one
referenced config file; recursive config inheritance is outside the first release.

Every setting declares its default, validation, and whether it is live-editable or
restart-required. Unknown core settings fail validation. Validate extension options
after loading their manifests. Expose effective values and provenance in the debugger.

## 6. Extension resolution and lifecycle

Support explicit `name` or `path`, exactly one per declaration:

```yaml
extensions:
  - name: adventure-land
  - name: custom-metrics
  - id: combat
    path: ./extensions/combat.js
    options:
      retreatHealth: 0.25
  - id: navigation
    path: /opt/bot/extensions/navigation.js
```

Name resolution checks built-ins, then the host's installed catalog. Node may also
resolve installed packages relative to the declaring document. Do not download or
install packages implicitly. Define collisions deterministically; built-in names
are reserved unless an explicit host override is configured.

Relative paths resolve against the declaring config or tree, never an accidental
process working directory. Node accepts filesystem paths and file URLs, including
Windows paths. Browsers accept relative, origin-relative, and absolute URLs.
Adventure Land uses its adapter's URL/script/module resolver. Arbitrary browser
filesystem imports are unavailable; normal CORS/CSP requirements still apply.

```js
export default {
  id: 'combat',
  version: '1.0.0',
  apiVersion: 1,
  dependencies: [],
  optionsSchema: { /* library schema vocabulary */ },
  setup(api, options) {
    api.registerNode('combat.attack', attackNode);
    api.registerResumeHandler('combat.arrived', arrivedHandler);
    return { dispose() { /* release owned resources */ } };
  }
};
```

Provide equivalent manifest registration for standalone scripts. Extension hooks can
register nodes, resume methods/handlers, codecs, value serializers, renderers,
services, and option schemas. Start with integer API compatibility and a documented
dependency format; avoid promising npm-style version-range parsing without implementing it.

Loading pipeline:

1. Decode documents and validate their envelope and core configuration structure.
2. Resolve referenced configuration and merge with provenance.
3. Resolve enabled extensions and load manifests, including declared dependencies.
4. Check identity, API compatibility, missing dependencies, and cycles.
5. Validate options and initialize in deterministic dependency order.
6. Validate tree types/bindings and instantiate the runner.

Loading is asynchronous. Cache module loading by canonical location while keeping
registrations and setup/disposal scoped to the owning library instance. On failure,
roll back registrations and dispose initialized extensions in reverse order; report
the source declaration, resolved location, and cause. Arbitrary import-time side
effects cannot be rolled back, so require extension authors to acquire resources
in setup and release them in dispose.

External extension loading executes trusted application code; it is not sandboxing.
Allow the host to restrict paths/origins through resolver policy. Inspect loaded
extensions, versions, dependencies, status, and errors through the debugger protocol.

## Phased delivery and acceptance gates

### Phase 1: Contracts and executable vertical slice

- Scaffold modules, built-in tests, declarations strategy, and build entry points.
  Implemented: strict TypeScript core, generated ESM/declarations in `dist/`,
  package exports, consumer type checks, and automatic builds for tests/examples.
- Implement definitions, frames, memory sequence, actions, result data, and a fake clock.
- Demonstrate input/output passing, a promise wait, cancellation, and engine stepping.
- Write public contracts for lifecycle, errors, timing, and scope ownership.

Gate: one definition runs in two isolated runners; late async results cannot revive
cancelled work; stepping pauses at a documented transition; no core host globals.

### Phase 2: Runtime and data completeness

- Add all resume mechanisms, named handlers, any/all, and cleanup contracts.
- Add remaining standard nodes, reactive preemption, parallel policies, and budgets.
  Implemented: memory/reactive sequences and selectors, synchronous conditions,
  retained activations, priority preemption, and bounded stepping/ticks.
  Next: inverter/force-result decorators, followed by time/retry/repeat decorators,
  parallel policies, and subtree invocation.
- Add optional blackboards, declarative bindings, subtree scopes, and output reducers.

Gate: deterministic scheduler tests cover cancellation races, simultaneous waits,
reactive interruption, parallel results, repeat budgets, and runs without a blackboard.

### Phase 3: Portable documents and configuration

- Implement canonical documents, JSON, type registries, migrations, and strict errors.
- Implement owned YAML parser/writer and conformance fixtures in parallel with schema work.
- Implement embedded/separate config, provenance, precedence, and config resolution.

Gate: equivalent JSON/YAML trees and configs yield equivalent canonical documents;
portable custom types round-trip; unsupported functions fail clearly; YAML edge cases
and configuration precedence have fixture-based coverage.

### Phase 4: Extension system and host adapters

- Implement catalogs, named/package/path resolution, manifests, setup, and disposal.
- Add dependency ordering, option validation, rollback, and capability inspection.
- Implement Node, browser, and Adventure Land loading/scheduling adapters.
- Produce the standalone global distribution with bundled built-ins.

Gate: load built-in, installed, relative, and absolute extensions; confirm relative
paths from separate configs; test missing/cyclic dependencies and cleanup after failure.
Run browser and Adventure Land smoke examples in their real host environments.

### Phase 5: Debugger controller and persistence

- Finish controls, conditional breakpoints, watchpoints, profiling, and inspection.
- Add bounded recording, historical snapshots, checkpoint capability checks/restore hooks.
- Implement local and Node remote transports, reconnect, and resynchronization.

Gate: controls behave consistently across nested and parallel activations; pause queues
external completions; history does not execute actions; bounded storage stays bounded;
supported checkpoints restore and unsupported pending operations report exact reasons.

### Phase 6: HTML renderers and customization

- Build list and nested-block renderers with shared debugger components.
- Publish renderer lifecycle/client contracts and a minimal custom UI example.
- Add keyboard interaction, readable status indicators, selection, and renderer switching.

Gate: both renderers expose the debugger feature set; a custom renderer works through
public APIs alone; simultaneous views and repeated mount/dispose leak no subscriptions.

### Phase 7: Release hardening and documentation

- Verify published artifacts have no external dependencies or unresolved imports.
- Document supported host versions and actual YAML conformance/profile limits.
- Publish examples for code-authored and file-authored trees, custom codecs, extensions,
  custom renderers, data flow, checkpoint restoration, and Adventure Land interruption.
- Measure scheduler cost, recording overhead, large-tree UI behavior, and bundle sizes.

Gate: all three environments load release artifacts; required features are demonstrated;
integration and conformance suites pass; unsupported capabilities are documented explicitly.

## Verification strategy and major risks

Use Node's built-in test runner, deterministic fake clocks, fixture-based documents,
and self-contained browser test pages. Exercise real Adventure Land separately from
adapter mocks. Record manual host checks honestly when automation is unavailable.
Use upstream YAML conformance cases with appropriate licensing/attribution; test
malformed input and limits as well as successful round trips.

Highest-risk work is the owned YAML implementation, precise debugger stepping across
parallel/reactive work, extension lifecycle cleanup, and restoring pending external
operations. Address each with a small demonstrator before broad API stabilization.
Do not estimate completion dates until the vertical slice and YAML conformance spike
establish realistic scope. Full time-travel side-effect reversal, arbitrary function
serialization, drag-and-drop editing, and automatic package installation are outside
this release plan.
