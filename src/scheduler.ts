import type { Clock, Runner, RunnerSnapshot } from './types.js';

export interface RunnerSchedulerOptions {
  /** Delay between drives, in milliseconds. Defaults to 16. */
  intervalMs?: number;
  /** Must schedule callbacks asynchronously, like the standard host timers. */
  clock?: Clock;
  beforeTick?: () => void;
  onTick?: (snapshot: RunnerSnapshot) => void;
  /** Hook/drive errors stop scheduling; without this callback they are rethrown. */
  onError?: (error: unknown) => void;
}
export interface RunnerScheduler {
  readonly running: boolean;
  start(): void;
  stop(): void;
  dispose(): void;
}

/** Owns only its drive timer, not the runner or the runner's pending operations. */
export function createRunnerScheduler(runner: Runner, options: RunnerSchedulerOptions = {}): RunnerScheduler {
  const { intervalMs = 16, beforeTick, onTick, onError } = options;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs must be finite and positive');
  const clock = options.clock ?? {
    setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(handle)
  };
  let running = false, disposed = false, generation = 0;
  let timer: unknown;
  let pending = false;
  function stop(): void {
    running = false;
    generation++;
    if (pending) { pending = false; clock.clearTimeout(timer); }
  }
  function active(snapshot: RunnerSnapshot): boolean {
    return snapshot.status === 'idle' || snapshot.status === 'RUNNING';
  }
  function schedule(token: number): void {
    try {
      timer = clock.setTimeout(() => drive(token), intervalMs);
      pending = true;
    } catch (error) { stop(); throw error; }
  }
  function drive(token: number): void {
    if (!running || token !== generation) return;
    pending = false;
    try {
      const state = runner.snapshot();
      if (!active(state)) { stop(); return; }
      if (!state.paused) {
        beforeTick?.();
        if (!running || token !== generation) return;
        const snapshot = runner.tick();
        onTick?.(snapshot);
        if (!running || token !== generation) return;
        if (!active(snapshot)) { stop(); return; }
      }
      if (running && token === generation) schedule(token);
    } catch (error) {
      stop();
      if (onError) onError(error);
      else throw error;
    }
  }
  return Object.freeze({
    get running() { return running; },
    start() {
      if (disposed) throw new Error('Scheduler is disposed');
      if (running || !active(runner.snapshot())) return;
      running = true;
      schedule(++generation);
    },
    stop,
    dispose() { stop(); disposed = true; }
  });
}
