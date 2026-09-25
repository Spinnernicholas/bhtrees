import type { Runner, RunnerSnapshot, FrameSnapshot, RunnerEvent } from './types.js';

export interface DebugEventSummary {
  readonly sequence: number;
  readonly type: RunnerEvent['type'];
  readonly nodeId: string;
  readonly activationId: number | null;
  readonly phase: RunnerEvent['phase'];
  readonly tick: number;
  readonly transition: number;
  readonly status: RunnerSnapshot['status'];
  readonly reason?: string;
}

export type DebugCommand = { type: 'pause' | 'continue' | 'stepInto' | 'tick' } |
  { type: 'cancel'; reason?: string } | { type: 'select'; activationId: number | null };
export interface DebugSnapshot {
  readonly events: readonly DebugEventSummary[];
  readonly droppedEvents: number;
  readonly version: 1;
  readonly revision: number;
  readonly runner: RunnerSnapshot;
  readonly selectedActivationId: number | null;
  readonly selection: FrameSnapshot | null;
}
export type DebugCommandResult = { readonly ok: true; readonly snapshot: DebugSnapshot } |
  { readonly ok: false; readonly code: 'INVALID_COMMAND' | 'INVALID_STATE' | 'BUSY' | 'DISPOSED' | 'EXECUTION_ERROR'; readonly message: string };
export interface DebuggerOptions {
  /** Retained metadata events; default 200, maximum 10000, zero disables collection. */
  eventLimit?: number;
  /** Observer errors are isolated from execution and other observers. */
  onListenerError?: (error: unknown) => void;
}
export interface DebuggerClient {
  readonly version: 1;
  readonly capabilities: readonly DebugCommand['type'][];
  /** Use this wrapper for external scheduling to publish snapshots automatically. */
  readonly runner: Runner;
  snapshot(): DebugSnapshot;
  subscribe(listener: (snapshot: DebugSnapshot) => void): () => void;
  command(command: DebugCommand): DebugCommandResult;
  /** Publish changes made directly to the original runner, including queued completions. */
  refresh(): DebugSnapshot;
  /** Detach observers without stopping, cancelling, or resetting the runner. */
  dispose(): void;
}

/** Local version-1 client. Snapshots are live inspection data, not historical copies. */
export function createDebugger(source: Runner, options: DebuggerOptions = {}): DebuggerClient {
  const eventLimit = options.eventLimit ?? 200;
  if (!Number.isInteger(eventLimit) || eventLimit < 0 || eventLimit > 10000) throw new RangeError('Invalid debugger event limit');
  const events: DebugEventSummary[] = [];
  let droppedEvents = 0;
  const unsubscribeEvents = eventLimit ? source.subscribe(event => {
    events.push(Object.freeze({ sequence: event.sequence, type: event.type, nodeId: event.nodeId,
      activationId: event.activationId, phase: event.phase, tick: event.snapshot.tick,
      transition: event.snapshot.transitions, status: event.snapshot.status,
      ...(event.reason === undefined ? {} : { reason: event.reason }) }));
    if (events.length > eventLimit) { events.shift(); droppedEvents++; }
  }) : () => {};
  const listeners = new Set<(snapshot: DebugSnapshot) => void>();
  let disposed = false, busy = false, revision = 0, selected: number | null = null;
  function capture(): DebugSnapshot {
    const runner = source.snapshot();
    const selection = runner.frames.find(frame => frame.activationId === selected) ?? null;
    if (!selection) selected = null;
    return Object.freeze({ version: 1, revision, runner, selectedActivationId: selected, selection,
      events: Object.freeze([...events]), droppedEvents });
  }
  let current = capture();
  function notify(listener: (snapshot: DebugSnapshot) => void): void {
    try { listener(current); }
    catch (error) {
      try { options.onListenerError?.(error); } catch { /* Observers cannot alter runner outcomes. */ }
    }
  }
  function publish(): DebugSnapshot {
    revision++;
    current = capture();
    for (const listener of [...listeners]) if (listeners.has(listener)) notify(listener);
    return current;
  }
  function drive<T>(fn: () => T): T {
    if (busy) throw new Error('Debugger is busy delivering or executing a command');
    busy = true;
    try {
      const result = fn();
      if (!disposed) publish();
      return result;
    } finally { busy = false; }
  }
  const runner: Runner = Object.freeze({
    subscribe: (listener: (event: RunnerEvent) => void) => source.subscribe(listener),
    tick: () => drive(() => source.tick()),
    step: () => drive(() => source.step()),
    pause: () => drive(() => source.pause()),
    continue: () => drive(() => source.continue()),
    cancel: (reason?: string) => drive(() => source.cancel(reason)),
    snapshot: () => source.snapshot()
  });
  function failure(code: Extract<DebugCommandResult, { ok: false }>['code'], message: string): DebugCommandResult {
    return Object.freeze({ ok: false, code, message });
  }
  return Object.freeze({
    version: 1,
    capabilities: Object.freeze(['pause', 'continue', 'stepInto', 'tick', 'cancel', 'select'] as const),
    runner,
    snapshot: () => current,
    subscribe(listener: (snapshot: DebugSnapshot) => void) {
      if (disposed) throw new Error('Debugger is disposed');
      if (typeof listener !== 'function') throw new TypeError('Expected a snapshot listener');
      // Each subscription owns its own registration, even for the same callback.
      const registration = (snapshot: DebugSnapshot) => listener(snapshot);
      listeners.add(registration);
      const wasBusy = busy;
      busy = true;
      try { notify(registration); } finally { busy = wasBusy; }
      return () => { listeners.delete(registration); };
    },
    command(input: DebugCommand): DebugCommandResult {
      if (disposed) return failure('DISPOSED', 'Debugger is disposed');
      if (busy) return failure('BUSY', 'Debugger is executing or notifying observers');
      try {
        if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
          return failure('INVALID_COMMAND', 'Expected a command record');
        }
        const fields = Object.getOwnPropertyDescriptors(input);
        if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !('value' in fields[key]))) {
          return failure('INVALID_COMMAND', 'Expected string-keyed command data');
        }
        const type = fields.type?.value;
        if (typeof type !== 'string' || !['pause', 'continue', 'stepInto', 'tick', 'cancel', 'select'].includes(type)) return failure('INVALID_COMMAND', 'Unknown command type');
        const allowed = type === 'cancel' ? ['type', 'reason'] : type === 'select' ? ['type', 'activationId'] : ['type'];
        if (Object.keys(fields).some(key => !allowed.includes(key))) return failure('INVALID_COMMAND', 'Unknown command field');
        const reason = fields.reason?.value, activationId = fields.activationId?.value;
        if (type === 'cancel' && reason !== undefined && typeof reason !== 'string') return failure('INVALID_COMMAND', 'Expected a string reason');
        if (type === 'select' && activationId !== null && (!Number.isSafeInteger(activationId) || activationId < 1)) {
          return failure('INVALID_COMMAND', 'Expected a positive activation ID or null');
        }
        const state = source.snapshot();
        if (type === 'select') {
          if (activationId !== null && !state.frames.some(frame => frame.activationId === activationId)) return failure('INVALID_STATE', 'Activation is not live');
        } else {
          if (!['idle', 'RUNNING'].includes(state.status)) return failure('INVALID_STATE', 'Runner is terminal');
          if (type === 'tick' && state.paused) return failure('INVALID_STATE', 'Continue before advancing a logical tick; use stepInto while paused');
        }
        drive(() => {
          switch (type) {
            case 'pause': source.pause(); break;
            case 'continue': source.continue(); break;
            case 'stepInto': source.step(); break;
            case 'tick': source.tick(); break;
            case 'cancel': source.cancel(reason); break;
            case 'select': selected = activationId; break;
          }
        });
        return Object.freeze({ ok: true, snapshot: current });
      } catch (error) { return failure('EXECUTION_ERROR', error instanceof Error ? error.message : String(error)); }
    },
    refresh() {
      if (disposed) throw new Error('Debugger is disposed');
      drive(() => undefined);
      return current;
    },
    dispose() { disposed = true; listeners.clear(); unsubscribeEvents(); }
  });
}
