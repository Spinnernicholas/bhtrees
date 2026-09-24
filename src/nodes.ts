import type { Reactive, ActionOptions, ActionDefinition, SequenceOptions, SequenceDefinition } from './types.js';

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
