export const SUCCESS = 'SUCCESS';
export const FAILURE = 'FAILURE';
export const RUNNING = 'RUNNING';

export function action({ id, enter, resume = {}, cancel }) {
  if (typeof id !== 'string' || !id || typeof enter !== 'function') {
    throw new TypeError('Actions require an id and enter function');
  }
  if (cancel !== undefined && typeof cancel !== 'function') throw new TypeError('Invalid cancel handler');
  for (const handler of Object.values(resume)) {
    if (typeof handler !== 'function') throw new TypeError('Invalid resume handler');
  }
  return Object.freeze({ type: 'action', id, enter, resume: Object.freeze({ ...resume }), cancel });
}

export function sequence({ id, steps, output = scope => scope.last }) {
  if (typeof id !== 'string' || !id || !Array.isArray(steps) || typeof output !== 'function') {
    throw new TypeError('Sequences require an id, steps array, and optional output function');
  }
  return Object.freeze({ type: 'sequence', id, output,
    steps: Object.freeze(steps.map(step => Object.freeze({ ...step }))) });
}
