import { RUNNING } from './nodes.js';

const descriptor = (kind, fields, options = {}) => ({ status: RUNNING, kind, ...fields,
  resolve: options.resume ?? options.resolve, reject: options.reject });

export const waits = Object.freeze({
  promise(promise, options) {
    if (!promise || typeof promise.then !== 'function') throw new TypeError('Expected a promise');
    // A race may settle before this descriptor is registered. Observe rejection now.
    Promise.resolve(promise).catch(() => {});
    return descriptor('promise', { promise }, options);
  },
  timer(ms, options) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Timer delay must be finite and nonnegative');
    return descriptor('timer', { ms, value: options?.value }, options);
  },
  event(subscribe, options) {
    if (typeof subscribe !== 'function') throw new TypeError('Expected a subscription function');
    return descriptor('event', { subscribe }, options);
  },
  poll(predicate, options) {
    if (typeof predicate !== 'function') throw new TypeError('Expected a polling function');
    return descriptor('poll', { predicate }, options);
  },
  any(children, options) { return group('any', children, options); },
  all(children, options) { return group('all', children, options); }
});

function group(kind, children, options) {
  if (!Array.isArray(children) || children.length === 0) throw new TypeError('Combined waits require at least one child');
  return descriptor(kind, { children: [...children] }, options);
}

/** Registrations only notify; disposal and execution happen at engine boundaries. */
export function registerWait(spec, clock, notify) {
  let settled = false, disposed = false, disposer;
  const children = [];
  function finish(value, rejected = false) {
    if (!disposed && !settled) { settled = true; notify(value, rejected); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    const errors = [];
    for (const child of children) {
      try { child.dispose(); } catch (error) { errors.push(error); }
    }
    try { disposer?.(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Wait cleanup failed');
  }
  try {
    switch (spec.kind) {
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
