import type { Value, NodeDefinition, RunnerOptions, Runner, RunnerStatus, RunnerSnapshot,
  ActionContext, Scope, ActionResult, Completion, WaitKind, FramePhase } from './types.js';

interface WaitToken {
  settled: boolean;
  dispose: (() => void) | null;
  kind: WaitKind;
  lastPoll: number;
  poll?: () => void;
}
interface TimerRegistration { ready: boolean; dispose(): void }
interface Frame {
  node: NodeDefinition;
  activationId: number;
  input: Value;
  local: Record<string, Value>;
  vars: Record<string, Value>;
  phase: FramePhase;
  index: number;
  last: Value;
  wait: WaitToken | null;
  children: Map<number, Frame>;
  effectiveReactive: boolean;
  traversal?: number;
  childResult?: Completion;
  started?: boolean;
  lastTick?: number;
  completedIterations?: number;
  timer?: TimerRegistration;
  timerStarted?: boolean;
}
interface ResumeEvent {
  frame: Frame;
  token: WaitToken;
  handler: string | undefined;
  value: Value;
  rejected: boolean;
}

import { SUCCESS, FAILURE, RUNNING } from './nodes.js';
import { waits, registerWait } from './waits.js';

/** Create an isolated execution instance. Inputs and outputs are immutable by contract. */
export function createRunner(root: NodeDefinition, { input, services = {}, maxStepsPerTick = 1000,
  clock = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: id => globalThis.clearTimeout(id) }
}: RunnerOptions = {}): Runner {
  if (!Number.isInteger(maxStepsPerTick) || maxStepsPerTick < 1) throw new RangeError('Invalid step budget');
  if (typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') throw new TypeError('Invalid clock');
  const definitions = new Map<string, NodeDefinition>();
  function validate(node: NodeDefinition, ancestors = new Set<NodeDefinition>()) {
    if (!node || !['action', 'condition', 'sequence', 'selector', 'inverter', 'forceSuccess', 'forceFailure', 'retry', 'repeat', 'delay', 'timeout', 'cooldown'].includes(node.type)) throw new TypeError('Invalid node');
    if (![undefined, true, false, 'inherited'].includes(node.reactive)) throw new TypeError('Invalid reactive setting');
    if (ancestors.has(node)) throw new TypeError('Cyclic tree definition');
    if (definitions.has(node.id) && definitions.get(node.id) !== node) throw new TypeError(`Duplicate node id: ${node.id}`);
    definitions.set(node.id, node);
    if ('child' in node) validate(node.child, new Set([...ancestors, node]));
    if (node.type === 'sequence' || node.type === 'selector') {
      for (const step of node.steps) {
        if (step.input !== undefined && typeof step.input !== 'function') throw new TypeError('Invalid input binding');
        if (step.save !== undefined && typeof step.save !== 'string') throw new TypeError('Invalid save binding');
        validate(step.node, new Set([...ancestors, node]));
      }
    }
  }
  validate(root);
  let serial = 0;
  let status: RunnerStatus = 'idle';
  let output: Value;
  let error: unknown;
  let paused = false;
  let executing = false;
  let tickNumber = 0;
  let driveNumber = 0;
  let transitionNumber = 0;
  let queue: ResumeEvent[] = [];
  const stack: Frame[] = [];
  const cooldowns = new Map<NodeDefinition, TimerRegistration>();
  let rootFrame: Frame | null = null;
  let traversal = 0, traversalOpen = false, yielded = false;

  function push(node: NodeDefinition, value: Value, parent?: Frame) {
    let frame = parent?.children.get(parent.index);
    if (!frame) {
      const reactive = node.reactive ?? 'inherited';
      frame = { node, activationId: ++serial, input: value, local: Object.create(null),
        vars: Object.create(null), phase: 'enter', index: 0, last: undefined, wait: null,
        completedIterations: node.type === 'retry' || node.type === 'repeat' ? 0 : undefined,
        children: new Map(), effectiveReactive: reactive === 'inherited' ? parent?.effectiveReactive ?? false : reactive };
      if (parent) parent.children.set(parent.index, frame);
      else rootFrame = frame;
    }
    stack.push(frame);
    prepare(frame);
  }

  function prepare(frame: Frame) {
    if (frame.traversal === traversal) return;
    frame.traversal = traversal;
    if (frame.node.type === 'sequence' || frame.node.type === 'selector') {
      if (frame.effectiveReactive) frame.index = 0;
      frame.phase = 'enter';
    }
  }

  function scope(frame: Frame): Scope {
    return { input: frame.input, vars: frame.vars, last: frame.last };
  }

  function context(frame: Frame): ActionContext {
    return { input: frame.input, local: frame.local, services,
      success: value => ({ status: SUCCESS, output: value }),
      failure: value => ({ status: FAILURE, output: value }),
      wait: waits
    };
  }

  function startTimer(ms: number): TimerRegistration {
    const timer: TimerRegistration = { ready: false, dispose: () => {} };
    const registration = registerWait(waits.timer(ms), clock, () => { timer.ready = true; });
    timer.dispose = registration.dispose;
    return timer;
  }

  function releaseTimer(frame: Frame) {
    const timer = frame.timer;
    frame.timer = undefined;
    timer?.dispose();
  }

  function clearCooldowns(failures: unknown[]) {
    const timers = [...cooldowns.values()];
    cooldowns.clear();
    for (const timer of timers) {
      try { timer.dispose(); } catch (cause) { failures.push(cause); }
    }
  }

  function complete(frame: Frame, result: Completion) {
    releaseTimer(frame);
    haltChildren(frame, 'interrupted');
    stack.pop();
    frame.wait = null;
    const parent = stack.at(-1);
    if (!parent) {
      const failures: unknown[] = [];
      clearCooldowns(failures);
      if (failures.length) throw new AggregateError(failures, 'Cooldown cleanup failed');
      rootFrame = null;
      status = result.status;
      output = result.output;
      return;
    }
    parent.children.delete(parent.index);
    parent.childResult = result;
    parent.phase = 'childResult';
  }

  function accept(frame: Frame, returned: ActionResult) {
    const result: Exclude<ActionResult, string> = returned === RUNNING ? { status: RUNNING } as const
      : returned === SUCCESS || returned === FAILURE ? { status: returned }
      : returned;
    if (frame.node.type !== 'action') throw new TypeError('Only actions return action results');
    if (result?.status === SUCCESS || result?.status === FAILURE) {
      complete(frame, result);
    } else if (result?.status === RUNNING) {
      if (frame.node.tick && result.kind === undefined) {
        frame.phase = 'running';
        yielded = true;
        return;
      }
      if (result.kind === undefined) throw new TypeError('A wait requires a named resume handler');
      const token: WaitToken = { settled: false, dispose: null, kind: result.kind, lastPoll: -1 };
      frame.wait = token;
      frame.phase = 'waiting';
      for (const name of [result.resolve, result.reject]) {
        if (name !== undefined && (!Object.hasOwn(frame.node.resume, name) || typeof frame.node.resume[name] !== 'function')) {
          // Consume a potentially rejected promise even when configuration is invalid.
          if (result.kind === 'promise') Promise.resolve(result.promise).catch(() => {});
          throw new TypeError(`Missing resume handler: ${String(name)}`);
        }
      }
      if (result.resolve === undefined) {
        if (result.kind === 'promise') Promise.resolve(result.promise).catch(() => {});
        throw new TypeError('A wait requires a named resume handler');
      }
      const registration = registerWait(result, clock, (value, rejected) =>
        enqueue(rejected ? result.reject : result.resolve, value, rejected));
      token.dispose = registration.dispose;
      token.poll = registration.poll;
      function enqueue(handler: string | undefined, value: Value, rejected: boolean) {
        if (frame.wait === token && status === RUNNING && !token.settled) {
          token.settled = true;
          queue.push({ frame, token, handler, value, rejected });
        }
      }
    } else {
      throw new TypeError(`Invalid result from ${frame.node.id}`);
    }
  }

  function release(frame: Frame) {
    const token = frame.wait;
    frame.wait = null;
    if (token?.dispose) {
      const dispose = token.dispose;
      token.dispose = null;
      dispose();
    }
  }

  function cleanup(reason: string) {
    const failures: unknown[] = [];
    queue = [];
    if (rootFrame) halt(rootFrame, reason, failures);
    clearCooldowns(failures);
    rootFrame = null;
    stack.length = 0;
    return failures;
  }

  function halt(frame: Frame, reason: string, failures: unknown[]) {
    for (const child of frame.children.values()) halt(child, reason, failures);
    frame.children.clear();
    queue = queue.filter(event => event.frame !== frame);
    try { release(frame); } catch (cause) { failures.push(cause); }
    try { releaseTimer(frame); } catch (cause) { failures.push(cause); }
    if (frame.node.type === 'action' && frame.node.cancel && frame.started) {
      try { frame.node.cancel(context(frame), reason); } catch (cause) { failures.push(cause); }
    }
  }

  function haltChildren(frame: Frame, reason: string, keep?: number) {
    const failures: unknown[] = [];
    for (const [index, child] of frame.children) {
      if (index === keep) continue;
      frame.children.delete(index);
      halt(child, reason, failures);
    }
    if (failures.length) throw new AggregateError(failures, 'Subtree interruption failed');
  }

  function finishTraversal() {
    // Only now is it known which previously running branches were not reached.
    for (const frame of stack) haltChildren(frame, 'interrupted', frame.index);
    traversalOpen = false;
  }

  function transition() {
    if (status === 'idle') {
      status = RUNNING;
      push(root, input);
      return true;
    }
    if (status !== RUNNING) return false;
    // An expired active timeout wins before another child transition. Outermost wins ties.
    const expired = stack.findIndex(frame => frame.node.type === 'timeout' &&
      frame.timer?.ready && frame.phase !== 'childResult');
    if (expired >= 0) {
      const frame = stack[expired];
      stack.length = expired + 1;
      haltChildren(frame, 'timeout');
      complete(frame, { status: FAILURE });
      return true;
    }
    const frame = stack.at(-1)!;
    if (frame.phase === 'waiting' && frame.node.type === 'action') {
      if (frame.wait!.lastPoll !== driveNumber) {
        frame.wait!.lastPoll = driveNumber;
        frame.wait!.poll!();
      }
      const eventIndex = queue.findIndex(event => event.frame === frame && event.token === frame.wait);
      const event = eventIndex < 0 ? undefined : queue.splice(eventIndex, 1)[0];
      if (!event) return false;
      release(frame);
      const handler = event.handler !== undefined && Object.hasOwn(frame.node.resume, event.handler) ? frame.node.resume[event.handler] : undefined;
      if (typeof handler !== 'function') {
        if (event.rejected && !event.handler) throw event.value;
        throw new TypeError(`Missing resume handler: ${String(event.handler)}`);
      }
      accept(frame, handler(context(frame), event.value));
      return true;
    }
    if (frame.node.type === 'condition') {
      const result: unknown = frame.node.test({ input: frame.input, local: frame.local, services });
      if (typeof result !== 'boolean') {
        // Observe rejected promises from invalid JavaScript predicates, as for poll waits.
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          Promise.resolve(result).catch(() => {});
        }
        throw new TypeError(`Condition ${frame.node.id} must return a synchronous boolean`);
      }
      complete(frame, { status: result ? SUCCESS : FAILURE });
      return true;
    }
    if (frame.node.type === 'action') {
      if (frame.node.tick && frame.lastTick === driveNumber) return false;
      frame.lastTick = driveNumber;
      frame.started = true;
      accept(frame, (frame.node.tick ?? frame.node.enter)!(context(frame)));
      return true;
    }
    if ('child' in frame.node) {
      if (frame.node.type === 'delay' && !frame.timerStarted) {
        frame.timerStarted = true;
        if (frame.node.ms > 0) {
          frame.timer = startTimer(frame.node.ms);
          frame.phase = 'waiting';
          return true;
        }
      }
      if (frame.node.type === 'delay' && frame.timer) {
        if (!frame.timer.ready) return false;
        releaseTimer(frame);
      }
      if (frame.node.type === 'timeout' && !frame.timerStarted) {
        frame.timerStarted = true;
        if (frame.node.ms === 0) { complete(frame, { status: FAILURE }); return true; }
        frame.timer = startTimer(frame.node.ms);
      }
      if (frame.node.type === 'cooldown' && frame.phase === 'enter') {
        const timer = cooldowns.get(frame.node);
        if (timer && !timer.ready) { complete(frame, { status: FAILURE }); return true; }
        if (timer) { cooldowns.delete(frame.node); timer.dispose(); }
      }
      if (frame.node.type === 'repeat' && frame.node.times === 0) {
        complete(frame, { status: SUCCESS });
        return true;
      }
      if (frame.phase === 'childResult') {
        const result = frame.childResult!;
        if (frame.node.type === 'delay' || frame.node.type === 'timeout' || frame.node.type === 'cooldown') {
          if (frame.node.type === 'cooldown' && frame.node.ms > 0) {
            cooldowns.set(frame.node, startTimer(frame.node.ms));
          }
          complete(frame, result);
          return true;
        }
        if (frame.node.type === 'retry' || frame.node.type === 'repeat') {
          frame.completedIterations = (frame.completedIterations ?? 0) + 1;
          const finished = frame.node.type === 'retry'
            ? result.status === SUCCESS || frame.completedIterations >= frame.node.attempts
            : result.status === FAILURE || frame.completedIterations >= frame.node.times;
          if (finished) complete(frame, result);
          else {
            frame.childResult = undefined;
            frame.phase = 'enter';
            // Yield at iteration boundaries so reactive ancestors can preempt even infinite loops.
            yielded = true;
          }
          return true;
        }
        const status = frame.node.type === 'inverter'
          ? result.status === SUCCESS ? FAILURE : SUCCESS
          : frame.node.type === 'forceSuccess' ? SUCCESS : FAILURE;
        complete(frame, { status, output: result.output });
      } else {
        frame.phase = 'child';
        push(frame.node.child, frame.input, frame);
      }
      return true;
    }
    if (frame.phase === 'childResult') {
      const result = frame.childResult!;
      if (frame.node.type === 'sequence' && result.status === FAILURE) {
        complete(frame, result);
        return true;
      }
      const binding = frame.node.steps[frame.index];
      if (result.status === SUCCESS && binding.save !== undefined) frame.vars[binding.save] = result.output;
      frame.last = result.output;
      if (frame.node.type === 'selector' && result.status === SUCCESS) {
        complete(frame, { status: SUCCESS, output: frame.node.output(scope(frame)) });
        return true;
      }
      frame.index++;
      frame.phase = 'enter';
      return true;
    }
    if (frame.index === frame.node.steps.length) {
      complete(frame, frame.node.type === 'sequence'
        ? { status: SUCCESS, output: frame.node.output(scope(frame)) }
        : { status: FAILURE, output: frame.last });
    } else {
      const binding = frame.node.steps[frame.index];
      const retained = frame.children.get(frame.index);
      const childInput = retained ? retained.input : binding.input ? binding.input(scope(frame)) : frame.input;
      frame.phase = 'child';
      push(binding.node, childInput, frame);
    }
    return true;
  }

  function snapshot(): RunnerSnapshot {
    const frames: Frame[] = [];
    function collect(frame: Frame) {
      frames.push(frame);
      for (const child of frame.children.values()) collect(child);
    }
    if (rootFrame) collect(rootFrame);
    return Object.freeze({ status, output, error, paused, tick: tickNumber, transitions: transitionNumber,
      queuedResumes: queue.length,
      frames: Object.freeze(frames.map(frame => Object.freeze({
        nodeId: frame.node.id, activationId: frame.activationId, phase: frame.phase,
        input: frame.input, local: Object.freeze({ ...frame.local }),
        vars: Object.freeze({ ...frame.vars }), childIndex: frame.index,
        reactive: frame.node.reactive ?? 'inherited', effectiveReactive: frame.effectiveReactive,
        onTraversal: stack.includes(frame),
        completedIterations: frame.completedIterations,
        waitingOn: frame.wait?.kind ?? (frame.node.type === 'delay' && frame.timer ? 'timer' : undefined)
      }))) });
  }

  function drive(budget: number, manual: boolean) {
    if (executing) throw new Error('Runner execution is not reentrant');
    if (paused && !manual) return snapshot();
    executing = true;
    driveNumber++;
    if (!manual) tickNumber++;
    try {
      yielded = false;
      if (!traversalOpen) {
        traversal++;
        traversalOpen = true;
        if (rootFrame) {
          stack.splice(0, stack.length, rootFrame);
          prepare(rootFrame);
          // Memory ancestors can resume directly at their retained running child.
          let frame = rootFrame;
          while (('child' in frame.node || frame.node.type === 'sequence' || frame.node.type === 'selector') &&
                 !frame.effectiveReactive && frame.children.has(frame.index)) {
            const child = frame.children.get(frame.index)!;
            frame.phase = 'child';
            stack.push(child);
            prepare(child);
            frame = child;
          }
        }
      }
      for (let count = 0; count < budget; count++) {
        if (!transition()) { finishTraversal(); break; }
        transitionNumber++;
        if (yielded || status !== RUNNING) { finishTraversal(); break; }
      }
    } catch (cause) {
      status = 'errored';
      const failures = cleanup('error');
      error = failures.length ? new AggregateError([cause, ...failures], 'Execution and cleanup failed') : cause;
    } finally {
      executing = false;
    }
    return snapshot();
  }

  return Object.freeze({
    tick: () => drive(maxStepsPerTick, false),
    step() { paused = true; return drive(1, true); },
    pause() { paused = true; },
    continue() { paused = false; },
    snapshot,
    cancel(reason = 'cancelled') {
      if (executing) throw new Error('Cannot cancel during a handler');
      if (status !== 'idle' && status !== RUNNING) return snapshot();
      status = 'cancelled';
      const failures = cleanup(reason);
      if (failures.length) error = new AggregateError(failures, 'Cancellation cleanup failed');
      return snapshot();
    }
  });
}
