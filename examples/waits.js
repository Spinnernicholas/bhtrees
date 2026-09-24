import { action, createRunner, RUNNING } from '../src/index.js';

// A tiny application event source; real applications can adapt their own emitter.
const listeners = new Set();
const task = action({
  id: 'timer-then-event',
  enter: ctx => ctx.wait.timer(20, { resume: 'listen' }),
  resume: {
    listen: ctx => ctx.wait.event(emit => {
      listeners.add(emit);
      return () => listeners.delete(emit);
    }, { resume: 'done' }),
    done: (ctx, message) => ctx.success(message)
  }
});

const runner = createRunner(task);
runner.tick();
// The application owns the execution loop, not the engine.
while (runner.snapshot().status === RUNNING) {
  await new Promise(resolve => setTimeout(resolve, 5));
  runner.tick();
  for (const emit of listeners) emit('Timer elapsed; event received.');
}
const result = runner.snapshot();
if (result.error) throw result.error;
console.log(result.output);
console.log(`Remaining listeners: ${listeners.size}`);
