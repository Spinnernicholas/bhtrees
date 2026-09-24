import { SUCCESS, FAILURE, RUNNING } from './nodes.js';
import { waits, registerWait } from './waits.js';

/** Create an isolated execution instance. Inputs and outputs are immutable by contract. */
export function createRunner(root, { input, services = {}, maxStepsPerTick = 1000,
  clock = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: id => globalThis.clearTimeout(id) }
} = {}) {
  if (!Number.isInteger(maxStepsPerTick) || maxStepsPerTick < 1) throw new RangeError('Invalid step budget');
  if (typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') throw new TypeError('Invalid clock');
  const definitions = new Map();
  function validate(node, ancestors = new Set()) {
    if (!node || !['action', 'sequence'].includes(node.type)) throw new TypeError('Invalid node');
    if (ancestors.has(node)) throw new TypeError('Cyclic tree definition');
    if (definitions.has(node.id) && definitions.get(node.id) !== node) throw new TypeError(`Duplicate node id: ${node.id}`);
    definitions.set(node.id, node);
    if (node.type === 'sequence') {
      for (const step of node.steps) {
        if (step.input !== undefined && typeof step.input !== 'function') throw new TypeError('Invalid input binding');
        if (step.save !== undefined && typeof step.save !== 'string') throw new TypeError('Invalid save binding');
        validate(step.node, new Set([...ancestors, node]));
      }
    }
  }
  validate(root);
  let serial = 0;
  let status = 'idle';
  let output;
  let error;
  let paused = false;
  let executing = false;
  let tickNumber = 0;
  let driveNumber = 0;
  let transitionNumber = 0;
  let queue = [];
  const stack = [];

  function push(node, value) {
    stack.push({ node, activationId: ++serial, input: value, local: Object.create(null),
      vars: Object.create(null), phase: 'enter', index: 0, last: undefined, wait: null });
  }

  function scope(frame) {
    return { input: frame.input, vars: frame.vars, last: frame.last };
  }

  function context(frame) {
    return { input: frame.input, local: frame.local, services,
      success: value => ({ status: SUCCESS, output: value }),
      failure: value => ({ status: FAILURE, output: value }),
      wait: waits
    };
  }

  function complete(frame, result) {
    stack.pop();
    frame.wait = null;
    const parent = stack.at(-1);
    if (!parent) {
      status = result.status;
      output = result.output;
      return;
    }
    parent.childResult = result;
    parent.phase = 'childResult';
  }

  function accept(frame, result) {
    if (result?.status === SUCCESS || result?.status === FAILURE) {
      complete(frame, result);
    } else if (result?.status === RUNNING) {
      const token = { settled: false, dispose: null, kind: result.kind, lastPoll: -1 };
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
      function enqueue(handler, value, rejected) {
        if (frame.wait === token && status === RUNNING && !token.settled) {
          token.settled = true;
          queue.push({ frame, token, handler, value, rejected });
        }
      }
    } else {
      throw new TypeError(`Invalid result from ${frame.node.id}`);
    }
  }

  function release(frame) {
    const token = frame.wait;
    frame.wait = null;
    if (token?.dispose) {
      const dispose = token.dispose;
      token.dispose = null;
      dispose();
    }
  }

  function cleanup(reason) {
    const failures = [];
    queue = [];
    for (const frame of stack.splice(0).reverse()) {
      try { release(frame); } catch (cause) { failures.push(cause); }
      if (frame.node.cancel && frame.started) {
        try { frame.node.cancel(context(frame), reason); } catch (cause) { failures.push(cause); }
      }
    }
    return failures;
  }

  function transition() {
    if (status === 'idle') {
      status = RUNNING;
      push(root, input);
      return true;
    }
    if (status !== RUNNING) return false;
    const frame = stack.at(-1);
    if (frame.phase === 'waiting') {
      if (frame.wait.lastPoll !== driveNumber) {
        frame.wait.lastPoll = driveNumber;
        frame.wait.poll();
      }
      const event = queue.shift();
      if (!event) return false;
      if (event.frame !== frame || event.token !== frame.wait) return true;
      release(frame);
      const handler = Object.hasOwn(frame.node.resume, event.handler) ? frame.node.resume[event.handler] : undefined;
      if (typeof handler !== 'function') {
        if (event.rejected && !event.handler) throw event.value;
        throw new TypeError(`Missing resume handler: ${String(event.handler)}`);
      }
      accept(frame, handler(context(frame), event.value));
      return true;
    }
    if (frame.node.type === 'action') {
      frame.started = true;
      accept(frame, frame.node.enter(context(frame)));
      return true;
    }
    if (frame.phase === 'childResult') {
      const result = frame.childResult;
      if (result.status === FAILURE) {
        complete(frame, result);
        return true;
      }
      const binding = frame.node.steps[frame.index];
      if (binding.save !== undefined) frame.vars[binding.save] = result.output;
      frame.last = result.output;
      frame.index++;
      frame.phase = 'enter';
      return true;
    }
    if (frame.index === frame.node.steps.length) {
      complete(frame, { status: SUCCESS, output: frame.node.output(scope(frame)) });
    } else {
      const binding = frame.node.steps[frame.index];
      const childInput = binding.input ? binding.input(scope(frame)) : frame.input;
      frame.phase = 'child';
      push(binding.node, childInput);
    }
    return true;
  }

  function snapshot() {
    return Object.freeze({ status, output, error, paused, tick: tickNumber, transitions: transitionNumber,
      queuedResumes: queue.length,
      frames: Object.freeze(stack.map(frame => Object.freeze({
        nodeId: frame.node.id, activationId: frame.activationId, phase: frame.phase,
        input: frame.input, local: Object.freeze({ ...frame.local }),
        vars: Object.freeze({ ...frame.vars }), childIndex: frame.index,
        waitingOn: frame.wait?.kind
      }))) });
  }

  function drive(budget, manual) {
    if (executing) throw new Error('Runner execution is not reentrant');
    if (paused && !manual) return snapshot();
    executing = true;
    driveNumber++;
    if (!manual) tickNumber++;
    try {
      for (let count = 0; count < budget; count++) {
        if (!transition()) break;
        transitionNumber++;
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
