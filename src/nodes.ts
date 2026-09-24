import type { Reactive, ActionOptions, ActionDefinition, SequenceOptions, SequenceDefinition,
  SelectorOptions, SelectorDefinition, ConditionOptions, ConditionDefinition,
  DecoratorKind, DecoratorOptions, DecoratorDefinition,
  RetryOptions, RetryDefinition, RepeatOptions, RepeatDefinition, TimedDecoratorKind, TimedDecoratorOptions, TimedDecoratorDefinition, SubtreeOptions, SubtreeDefinition } from './types.js';

export const SUCCESS = 'SUCCESS';
export const FAILURE = 'FAILURE';
export const RUNNING = 'RUNNING';

function checkReactive(reactive: Reactive) {
  if (![true, false, 'inherited'].includes(reactive)) throw new TypeError('Invalid reactive setting');
}

export function action({ id, enter, tick, resume = {}, cancel, reactive = 'inherited' }: ActionOptions): ActionDefinition {
  checkReactive(reactive);
  if (typeof id !== 'string' || !id ||
      (tick === undefined ? typeof enter !== 'function' : typeof tick !== 'function' || enter !== undefined)) {
    throw new TypeError('Actions require an id and either an enter or tick function');
  }
  if (cancel !== undefined && typeof cancel !== 'function') throw new TypeError('Invalid cancel handler');
  for (const handler of Object.values(resume)) {
    if (typeof handler !== 'function') throw new TypeError('Invalid resume handler');
  }
  // Runtime validation above guarantees exactly one of enter/tick is present.
  return Object.freeze({ type: 'action', id, enter, tick, resume: Object.freeze({ ...resume }), cancel, reactive }) as ActionDefinition;
}

export function sequence({ id, steps, output = scope => scope.last, reactive = 'inherited' }: SequenceOptions): SequenceDefinition {
  checkReactive(reactive);
  if (typeof id !== 'string' || !id || !Array.isArray(steps) || typeof output !== 'function') {
    throw new TypeError('Sequences require an id, steps array, and optional output function');
  }
  return Object.freeze({ type: 'sequence', id, output, reactive,
    steps: Object.freeze(steps.map(step => Object.freeze({ ...step }))) });
}

export function selector({ id, steps, output = scope => scope.last, reactive = 'inherited' }: SelectorOptions): SelectorDefinition {
  checkReactive(reactive);
  if (typeof id !== 'string' || !id || !Array.isArray(steps) || typeof output !== 'function') {
    throw new TypeError('Selectors require an id, steps array, and optional output function');
  }
  return Object.freeze({ type: 'selector', id, output, reactive,
    steps: Object.freeze(steps.map(step => Object.freeze({ ...step }))) });
}

export function condition({ id, test, reactive = 'inherited' }: ConditionOptions): ConditionDefinition {
  checkReactive(reactive);
  if (typeof id !== 'string' || !id || typeof test !== 'function') {
    throw new TypeError('Conditions require an id and test function');
  }
  return Object.freeze({ type: 'condition', id, test, reactive });
}

function decorator<T extends DecoratorKind | 'retry' | 'repeat' | TimedDecoratorKind | 'subtree'>(type: T, { id, child, reactive = 'inherited' }: DecoratorOptions) {
  checkReactive(reactive);
  if (typeof id !== 'string' || !id || !child || typeof child !== 'object') {
    throw new TypeError('Decorators require an id and child node');
  }
  return Object.freeze({ type, id, child, reactive });
}

export function inverter(options: DecoratorOptions): DecoratorDefinition { return decorator('inverter', options); }
export function forceSuccess(options: DecoratorOptions): DecoratorDefinition { return decorator('forceSuccess', options); }
export function forceFailure(options: DecoratorOptions): DecoratorDefinition { return decorator('forceFailure', options); }

function checkCount(value: number, minimum: number, name: string) {
  if (value !== Infinity && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum} or Infinity`);
  }
}

export function retry({ attempts, ...options }: RetryOptions): RetryDefinition {
  checkCount(attempts, 1, 'Retry attempts');
  return Object.freeze({ ...decorator('retry', options), attempts });
}

export function repeat({ times, ...options }: RepeatOptions): RepeatDefinition {
  checkCount(times, 0, 'Repeat times');
  return Object.freeze({ ...decorator('repeat', options), times });
}

function timed(type: TimedDecoratorKind, { ms, ...options }: TimedDecoratorOptions): TimedDecoratorDefinition {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Decorator delay must be finite and nonnegative');
  return Object.freeze({ ...decorator(type, options), ms });
}
export function delay(options: TimedDecoratorOptions): TimedDecoratorDefinition { return timed('delay', options); }
export function timeout(options: TimedDecoratorOptions): TimedDecoratorDefinition { return timed('timeout', options); }
export function cooldown(options: TimedDecoratorOptions): TimedDecoratorDefinition { return timed('cooldown', options); }

export function subtree({ input, output = scope => scope.last, ...options }: SubtreeOptions): SubtreeDefinition {
  if (input !== undefined && typeof input !== 'function') throw new TypeError('Invalid subtree input binding');
  if (typeof output !== 'function') throw new TypeError('Invalid subtree output binding');
  return Object.freeze({ ...decorator('subtree', options), input, output });
}
