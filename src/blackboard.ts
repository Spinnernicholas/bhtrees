import type { Value, Blackboard, BlackboardChange, BlackboardListener, BlackboardSnapshot } from './types.js';

/** Observable top-level state. Object values remain application-owned. */
export function createBlackboard(initial: Readonly<Record<string, Value>> = {}): Blackboard {
  if (!initial || typeof initial !== 'object' || Array.isArray(initial) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(initial))) {
    throw new TypeError('Blackboard initial state must be a plain record');
  }
  const values = new Map<string, Value>(Object.entries(initial));
  const listeners = new Set<BlackboardListener>();
  let revision = 0;
  let cached: BlackboardSnapshot | undefined;
  let notifying = false;
  const pending: BlackboardChange[] = [];

  function checkKey(key: string) {
    if (typeof key !== 'string') throw new TypeError('Blackboard keys must be strings');
  }

  function notify(type: 'set' | 'delete', key: string, hadValue: boolean, previous: Value, value: Value) {
    cached = undefined;
    pending.push(Object.freeze({ revision: ++revision, type, key, hadValue, previous, value }));
    if (notifying) return;
    notifying = true;
    const errors: unknown[] = [];
    try {
      // Reentrant writes enqueue events so every observer sees increasing revisions.
      for (let index = 0; index < pending.length; index++) {
        const change = pending[index];
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue;
          try { listener(change); } catch (error) { errors.push(error); }
        }
      }
    } finally { pending.length = 0; notifying = false; }
    // The write remains committed even if an observer throws.
    if (errors.length) throw new AggregateError(errors, 'Blackboard subscribers failed');
  }

  return Object.freeze({
    get revision() { return revision; },
    has(key: string) { checkKey(key); return values.has(key); },
    get(key: string) { checkKey(key); return values.get(key); },
    set(key: string, value: Value) {
      checkKey(key);
      const hadValue = values.has(key), previous = values.get(key);
      if (hadValue && Object.is(previous, value)) return;
      values.set(key, value);
      notify('set', key, hadValue, previous, value);
    },
    delete(key: string) {
      checkKey(key);
      if (!values.has(key)) return false;
      const previous = values.get(key);
      values.delete(key);
      notify('delete', key, true, previous, undefined);
      return true;
    },
    snapshot() {
      if (!cached) {
        const record = Object.create(null) as Record<string, Value>;
        for (const [key, value] of values) record[key] = value;
        cached = Object.freeze({ revision, values: Object.freeze(record) });
      }
      return cached;
    },
    subscribe(listener: BlackboardListener) {
      if (typeof listener !== 'function') throw new TypeError('Blackboard subscriber must be a function');
      // Each subscription is independently disposable, even for the same listener.
      const subscription: BlackboardListener = change => listener(change);
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    }
  });
}
