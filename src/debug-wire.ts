export type DebugValue = null | boolean | number | string | DebugValue[] | { [key: string]: DebugValue };

/** Bounded descriptive inspection; never calls getters or toJSON. Not a checkpoint codec. */
export function inspectDebugValue(value: unknown): DebugValue {
  let remaining = 10000;
  const seen = new WeakSet<object>();
  const mark = (description: string): DebugValue => ({ $debug: description });
  function visit(value: unknown, depth: number): DebugValue {
    if (--remaining < 0) return mark('value limit');
    if (typeof value === 'string') return value.length > 2048 ? value.slice(0, 2048) + '…[truncated]' : value;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : mark(String(value));
    if (typeof value !== 'object') return mark(typeof value === 'bigint' ? `${value}n` : typeof value);
    if (depth >= 10) return mark('depth limit');
    if (seen.has(value)) return mark('circular or shared reference');
    seen.add(value);
    try {
      const result: { [key: string]: DebugValue } = Object.create(null);
      const keys = Object.getOwnPropertyNames(value);
      for (const key of keys.slice(0, 200)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        result[key] = descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : mark('accessor');
      }
      if (Array.isArray(value)) {
        const length = Math.min(value.length, 200);
        const array = Array.from({ length }, (_, i) => result[String(i)] ?? mark('empty'));
        if (value.length > length) array.push(mark('item limit'));
        return array;
      }
      if (keys.length > 200) result.$debugTruncated = 'property limit';
      return result;
    } catch { return mark('unavailable'); }
  }
  return visit(value, 0);
}
