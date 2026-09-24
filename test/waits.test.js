import test from 'node:test';
import assert from 'node:assert/strict';
import { action, createRunner, RUNNING, SUCCESS } from '../dist/index.js';

function fakeClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (timer.due <= now && timers.delete(id)) timer.fn();
      }
    },
    get size() { return timers.size; }
  };
}

test('timers use elapsed time and queue through pause', () => {
  const clock = fakeClock();
  const runner = createRunner(action({ id: 'delay',
    enter: c => c.wait.timer(100, { resume: 'done', value: 42 }),
    resume: { done: (c, value) => c.success(value) }
  }), { clock });
  runner.tick();
  assert.equal(runner.snapshot().frames[0].waitingOn, 'timer');
  for (let i = 0; i < 10; i++) assert.equal(runner.tick().status, RUNNING);
  clock.advance(99); assert.equal(runner.tick().status, RUNNING);
  runner.pause(); clock.advance(1);
  assert.equal(runner.tick().status, RUNNING);
  assert.equal(runner.step().output, 42);
  assert.equal(clock.size, 0);
});

test('cancel removes timer and prevents resumption', () => {
  const clock = fakeClock();
  const runner = createRunner(action({ id: 'delay',
    enter: c => c.wait.timer(10, { resume: 'done' }),
    resume: { done() { assert.fail('cancelled timer resumed'); } }
  }), { clock });
  runner.tick(); assert.equal(clock.size, 1);
  runner.cancel(); assert.equal(clock.size, 0);
  clock.advance(100); assert.equal(runner.tick().status, 'cancelled');
});

test('synchronous subscription events settle once and dispose before resume', () => {
  let disposed = 0;
  const runner = createRunner(action({ id: 'event',
    enter: c => c.wait.event(emit => {
      emit('first'); emit('second');
      return () => { disposed++; };
    }, { resume: 'done' }),
    resume: { done(c, value) { assert.equal(disposed, 1); return c.success(value); } }
  }));
  assert.equal(runner.tick().output, 'first');
  runner.cancel(); assert.equal(disposed, 1);
});

test('event cancellation disposes once and ignores retained callbacks', () => {
  let emit, disposed = 0;
  const runner = createRunner(action({ id: 'event',
    enter: c => c.wait.event(fn => { emit = fn; return () => { disposed++; }; }, { resume: 'done' }),
    resume: { done: c => c.success() }
  }));
  runner.tick(); emit(1); emit(2);
  assert.equal(runner.snapshot().queuedResumes, 1);
  runner.cancel(); emit(3); runner.cancel();
  assert.equal(disposed, 1);
  assert.equal(runner.snapshot().queuedResumes, 0);
});

test('a named continuation can install another kind of wait', () => {
  const clock = fakeClock();
  let emit;
  const runner = createRunner(action({ id: 'stages',
    enter: c => c.wait.timer(5, { resume: 'listen' }),
    resume: {
      listen: c => c.wait.event(fn => { emit = fn; return () => {}; }, { resume: 'done' }),
      done: (c, value) => c.success(value)
    }
  }), { clock });
  runner.tick(); clock.advance(5); runner.tick(); emit('complete');
  assert.equal(runner.tick().status, SUCCESS);
  assert.equal(runner.snapshot().output, 'complete');
});

test('disposal errors do not skip action cancellation', () => {
  let cancelled = 0;
  const runner = createRunner(action({ id: 'event',
    enter: c => c.wait.event(() => () => { throw new Error('unsubscribe failed'); }, { resume: 'done' }),
    resume: { done: c => c.success() }, cancel() { cancelled++; }
  }));
  runner.tick(); const result = runner.cancel();
  assert.equal(cancelled, 1);
  assert.equal(result.error.errors[0].message, 'unsubscribe failed');
});

test('invalid handlers fail before acquiring event resources', () => {
  let subscribed = false;
  const runner = createRunner(action({ id: 'invalid',
    enter: c => c.wait.event(() => { subscribed = true; return () => {}; }, { resume: 'missing' })
  }));
  assert.equal(runner.tick().status, 'errored');
  assert.equal(subscribed, false);
});
