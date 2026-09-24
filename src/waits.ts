import type { Value, Clock, WaitDescriptor, WaitOptions, CallbackToken } from './types.js';

import { RUNNING } from './nodes.js';

type WaitFields = WaitDescriptor extends infer D ? D extends WaitDescriptor ? Omit<D, 'status' | 'resolve' | 'reject'> : never : never;
const descriptor = (fields: WaitFields, options: WaitOptions = {}): WaitDescriptor => ({ status: RUNNING, ...fields,
  resolve: options.resume ?? options.resolve, reject: options.reject });

interface CallbackState {
  registered: boolean;
  disposed: boolean;
  settled: boolean;
  rejected: boolean;
  value?: Value;
  notify?: (value: Value, rejected: boolean) => void;
}
const callbacks = new WeakMap<WaitDescriptor, CallbackState>();

export const waits = Object.freeze({
  callback(options?: WaitOptions): CallbackToken {
    const wait = Object.freeze(descriptor({ kind: 'callback' }, options));
    const state: CallbackState = { registered: false, disposed: false, settled: false, rejected: false };
    callbacks.set(wait, state);
    function settle(value: Value, rejected: boolean) {
      if (state.disposed || state.settled) return false;
      state.settled = true;
      state.rejected = rejected;
      state.value = value;
      state.notify?.(value, rejected);
      return true;
    }
    return Object.freeze({ wait,
      resolve: (value?: Value) => settle(value, false),
      reject: (error?: Value) => settle(error, true)
    });
  },
  promise(promise: PromiseLike<Value>, options?: WaitOptions) {
    if (!promise || typeof promise.then !== 'function') throw new TypeError('Expected a promise');
    // A race may settle before this descriptor is registered. Observe rejection now.
    Promise.resolve(promise).catch(() => {});
    return descriptor({ kind: 'promise', promise }, options);
  },
  timer(ms: number, options?: WaitOptions & { value?: Value }) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Timer delay must be finite and nonnegative');
    return descriptor({ kind: 'timer', ms, value: options?.value }, options);
  },
  event(subscribe: (notify: (value?: Value) => void) => () => void, options?: WaitOptions) {
    if (typeof subscribe !== 'function') throw new TypeError('Expected a subscription function');
    return descriptor({ kind: 'event', subscribe }, options);
  },
  poll(predicate: () => Value, options?: WaitOptions) {
    if (typeof predicate !== 'function') throw new TypeError('Expected a polling function');
    return descriptor({ kind: 'poll', predicate }, options);
  },
  any(children: readonly WaitDescriptor[], options?: WaitOptions) { return group('any', children, options); },
  all(children: readonly WaitDescriptor[], options?: WaitOptions) { return group('all', children, options); }
});

function group(kind: 'any' | 'all', children: readonly WaitDescriptor[], options?: WaitOptions) {
  if (!Array.isArray(children) || children.length === 0) throw new TypeError('Combined waits require at least one child');
  return descriptor({ kind, children: [...children] }, options);
}

/** Registrations only notify; disposal and execution happen at engine boundaries. */
export function registerWait(spec: WaitDescriptor, clock: Clock, notify: (value: Value, rejected: boolean) => void): WaitRegistration {
  let settled = false, disposed = false;
  let disposer: (() => void) | undefined;
  const children: WaitRegistration[] = [];
  function finish(value: Value, rejected = false) {
    if (!disposed && !settled) { settled = true; notify(value, rejected); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    for (const child of children) {
      try { child.dispose(); } catch (error) { errors.push(error); }
    }
    try { disposer?.(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Wait cleanup failed');
  }
  try {
    switch (spec.kind) {
      case 'callback': {
        const state = callbacks.get(spec);
        if (!state) throw new TypeError('Callback waits must be created by wait.callback');
        if (state.registered) throw new TypeError('Callback tokens can only be registered once');
        state.registered = true;
        state.notify = finish;
        disposer = () => { state.disposed = true; state.notify = undefined; state.value = undefined; };
        if (state.settled) finish(state.value, state.rejected);
        break;
      }
      case 'promise':
        Promise.resolve(spec.promise).then(value => finish(value), error => finish(error, true));
        break;
      case 'timer': {
        const id = clock.setTimeout(() => finish(spec.value), spec.ms);
        disposer = () => clock.clearTimeout(id);
        break;
      }
      case 'event':
        disposer = spec.subscribe(value => finish(value));
        if (typeof disposer !== 'function') { disposer = undefined; throw new TypeError('Subscription must return an unsubscribe function'); }
        break;
      case 'poll': break;
      case 'any':
      case 'all': {
        const values = new Array(spec.children.length);
        let remaining = values.length;
        for (const [index, child] of spec.children.entries()) {
          if (settled) break;
          children.push(registerWait(child, clock, (value, rejected) => {
            if (rejected) finish(value, true);
            else if (spec.kind === 'any') finish({ index, value });
            else { values[index] = value; if (--remaining === 0) finish(values); }
          }));
        }
        break;
      }
      default: throw new TypeError('Invalid wait descriptor');
    }
  } catch (error) {
    try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Wait setup failed'); }
    throw error;
  }
  return {
    dispose,
    poll() {
      if (settled || disposed) return;
      if (spec.kind === 'poll') {
        const value = spec.predicate();
        if (value && typeof value.then === 'function') {
          Promise.resolve(value).catch(() => {});
          throw new TypeError('Polling predicates must be synchronous');
        }
        if (value) finish(value);
      }
      for (const child of children) { if (settled) break; child.poll(); }
    }
  };
}

export interface WaitRegistration { dispose(): void; poll(): void }
