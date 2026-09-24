import type { PathBinding, Value } from './types.js';

type BindingFunction = (...args: Value[]) => Value;

/** Copy declarative paths so definitions cannot be changed through caller-owned arrays. */
export function normalizeBinding<T extends BindingFunction>(binding: T | PathBinding, label: string): T | PathBinding {
  if (typeof binding === 'function') return binding;
  const invalid = () => new TypeError(`Invalid ${label}: expected a function or { path: [string or nonnegative integer, ...] }`);
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw invalid();
  const property = Object.getOwnPropertyDescriptor(binding, 'path');
  if (!property || !('value' in property) || !Array.isArray(property.value) || Reflect.ownKeys(binding).length !== 1) throw invalid();
  const path = [];
  for (const segment of property.value) {
    if (typeof segment !== 'string' && !(Number.isSafeInteger(segment) && segment >= 0)) throw invalid();
    path.push(segment);
  }
  return Object.freeze({ path: Object.freeze(path) });
}

/** Data lookup only: no inherited properties, accessors, expressions, or function traversal. */
export function evaluateBinding(binding: BindingFunction | PathBinding, source: Value, args: Value[]): Value {
  if (typeof binding === 'function') return binding(...args);
  let value = source;
  for (const segment of binding.path) {
    if (value === null || typeof value !== 'object') return undefined;
    const property = Object.getOwnPropertyDescriptor(value, segment);
    if (!property) return undefined;
    if (!('value' in property)) throw new TypeError(`Binding path cannot read accessor property ${String(segment)}`);
    value = property.value;
  }
  return value;
}
