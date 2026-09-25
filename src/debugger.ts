import type { Runner, RunnerSnapshot, FrameSnapshot, RunnerEvent, RunnerEntryBoundary, RunnerResumeBoundary, BlackboardChange, BlackboardListener } from './types.js';

export interface DebugWatchpoint {
  readonly key: string;
  readonly operation: 'set' | 'delete' | 'any';
}

export interface EntryBreakpoint {
  /** Defaults to entry for compatibility. Conditions inspect activation input for both kinds. */
  readonly kind?: 'entry' | 'resume';
  readonly nodeId: string;
  /** Own data-property path within activation input; omitted means unconditional. */
  readonly inputPath?: readonly string[];
  readonly equals?: string | number | boolean | null;
}

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

export interface DebugStepResult {
  readonly command: 'stepOver' | 'stepOut';
  readonly targetActivationId: number;
  readonly transitions: number;
  readonly reason: 'target-left' | 'blocked' | 'budget' | 'breakpoint' | 'watchpoint' | 'terminal';
}
export type DebugCommand = { type: 'pause' | 'continue' | 'stepInto' | 'stepOver' | 'stepOut' | 'tick' } |
  { type: 'cancel'; reason?: string } | { type: 'select'; activationId: number | null } |
  ({ type: 'setBreakpoint' } & EntryBreakpoint) | { type: 'removeBreakpoint'; nodeId: string; kind?: 'entry' | 'resume' } |
  { type: 'setWatchpoint'; key: string; operation?: DebugWatchpoint['operation'] } | { type: 'removeWatchpoint'; key: string };
export interface DebugSnapshot {
  readonly watchpoints: readonly DebugWatchpoint[];
  readonly watchpointHit: Readonly<BlackboardChange> | null;
  readonly stepResult: DebugStepResult | null;
  readonly breakpoints: readonly EntryBreakpoint[];
  readonly breakpointHit: { readonly nodeId: string; readonly activationId: number; readonly kind: 'entry' | 'resume'; readonly handler?: string | null } | null;
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
  /** Maximum drives in one step-over/out command; default 1000, maximum 10000. */
  stepBudget?: number;
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
  const stepBudget = options.stepBudget ?? 1000;
  if (!Number.isInteger(stepBudget) || stepBudget < 1 || stepBudget > 10000) throw new RangeError('Invalid debugger step budget');
  if (!Number.isInteger(eventLimit) || eventLimit < 0 || eventLimit > 10000) throw new RangeError('Invalid debugger event limit');
  const events: DebugEventSummary[] = [];
  const breakpoints = new Map<string, EntryBreakpoint>();
  const watchpoints = new Map<string, DebugWatchpoint>();
  let watchpointHit: Readonly<BlackboardChange> | null = null;
  let unsubscribeWrites: (() => void) | undefined;
  let breakpointHit: DebugSnapshot['breakpointHit'] = null;
  let stepResult: DebugStepResult | null = null;
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
  const breakpointKey = (nodeId: string, kind: 'entry' | 'resume') => JSON.stringify([kind, nodeId]);
  function matchBreakpoint(boundary: RunnerEntryBoundary, kind: 'entry' | 'resume', handler?: string | null) {
    const breakpoint = breakpoints.get(breakpointKey(boundary.nodeId, kind));
    if (!breakpoint) return;
    if (breakpoint.inputPath) {
      let value: unknown = boundary.snapshot.frames.find(frame => frame.activationId === boundary.activationId)?.input;
      for (const key of breakpoint.inputPath) {
        if (value === null || typeof value !== 'object') return;
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !('value' in property)) return;
        value = property.value;
      }
      if (value !== breakpoint.equals) return;
    }
    breakpointHit = Object.freeze({ nodeId: boundary.nodeId, activationId: boundary.activationId, kind,
      ...(kind === 'resume' ? { handler: handler ?? null } : {}) });
    selected = boundary.activationId;
    return true;
  }
  const unsubscribeEntries = source.beforeEnter(boundary => matchBreakpoint(boundary, 'entry'));
  const unsubscribeResumes = source.beforeResume(boundary => matchBreakpoint(boundary, 'resume', boundary.handler));
  function capture(): DebugSnapshot {
    const runner = source.snapshot();
    if (!runner.paused || !runner.frames.some(frame => frame.activationId === breakpointHit?.activationId)) breakpointHit = null;
    const selection = runner.frames.find(frame => frame.activationId === selected) ?? null;
    if (!selection) selected = null;
    return Object.freeze({ version: 1, revision, runner, selectedActivationId: selected, selection,
      events: Object.freeze([...events]), droppedEvents, breakpoints: Object.freeze([...breakpoints.values()]), breakpointHit, stepResult,
      watchpoints: Object.freeze([...watchpoints.values()]), watchpointHit });
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
    beforeResume: (listener: (boundary: RunnerResumeBoundary) => boolean | void) => source.beforeResume(listener),
    observeBlackboard: (listener: BlackboardListener) => source.observeBlackboard(listener),
    beforeEnter: (listener: (boundary: RunnerEntryBoundary) => boolean | void) => source.beforeEnter(listener),
    subscribe: (listener: (event: RunnerEvent) => void) => source.subscribe(listener),
    tick: () => drive(() => { stepResult = null; if (!source.snapshot().paused) watchpointHit = null; return source.tick(); }),
    step: () => drive(() => { watchpointHit = null; stepResult = null; breakpointHit = null; return source.step(); }),
    pause: () => drive(() => source.pause()),
    continue: () => drive(() => { watchpointHit = null; stepResult = null; source.continue(); }),
    cancel: (reason?: string) => drive(() => { watchpointHit = null; stepResult = null; return source.cancel(reason); }),
    snapshot: () => source.snapshot()
  });
  function failure(code: Extract<DebugCommandResult, { ok: false }>['code'], message: string): DebugCommandResult {
    return Object.freeze({ ok: false, code, message });
  }
  function advance(command: 'stepOver' | 'stepOut', target: number): void {
    const initial = source.snapshot().transitions;
    let reason: DebugStepResult['reason'] = 'budget';
    breakpointHit = null;
    for (let count = 0; count < stepBudget; count++) {
      const before = source.snapshot().transitions;
      const state = source.step();
      if (watchpointHit) { reason = 'watchpoint'; break; }
      if (breakpointHit) { reason = 'breakpoint'; break; }
      if (!['idle', 'RUNNING'].includes(state.status)) { reason = 'terminal'; break; }
      if (!state.frames.some(frame => frame.activationId === target)) { reason = 'target-left'; break; }
      // Do not spin waiting for external work or repeatedly tick a RUNNING action.
      if (state.transitions === before || state.frames.some(frame => frame.onTraversal && ['running', 'waiting'].includes(frame.phase))) {
        reason = 'blocked'; break;
      }
    }
    stepResult = Object.freeze({ command, targetActivationId: target, transitions: source.snapshot().transitions - initial, reason });
  }
  return Object.freeze({
    version: 1,
    capabilities: Object.freeze(['pause', 'continue', 'stepInto', 'stepOver', 'stepOut', 'tick', 'cancel', 'select', 'setBreakpoint', 'removeBreakpoint', 'setWatchpoint', 'removeWatchpoint'] as const),
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
        if (typeof type !== 'string' || !['pause', 'continue', 'stepInto', 'stepOver', 'stepOut', 'tick', 'cancel', 'select', 'setBreakpoint', 'removeBreakpoint', 'setWatchpoint', 'removeWatchpoint'].includes(type)) return failure('INVALID_COMMAND', 'Unknown command type');
        const allowed = type === 'cancel' ? ['type', 'reason'] : type === 'select' ? ['type', 'activationId'] :
          type === 'setBreakpoint' ? ['type', 'nodeId', 'kind', 'inputPath', 'equals'] : type === 'removeBreakpoint' ? ['type', 'nodeId', 'kind'] :
          type === 'setWatchpoint' ? ['type', 'key', 'operation'] : type === 'removeWatchpoint' ? ['type', 'key'] : ['type'];
        if (Object.keys(fields).some(key => !allowed.includes(key))) return failure('INVALID_COMMAND', 'Unknown command field');
        const reason = fields.reason?.value, activationId = fields.activationId?.value;
        const nodeId = fields.nodeId?.value, inputPath = fields.inputPath?.value, equals = fields.equals?.value;
        const kind = fields.kind?.value === undefined ? 'entry' : fields.kind.value;
        const key = fields.key?.value, operation = fields.operation?.value === undefined ? 'any' : fields.operation.value;
        if (type === 'setWatchpoint' || type === 'removeWatchpoint') {
          if (typeof key !== 'string' || key.length > 1024) return failure('INVALID_COMMAND', 'Expected a blackboard key of at most 1024 characters');
          if (!['set', 'delete', 'any'].includes(operation)) return failure('INVALID_COMMAND', 'Expected set, delete or any operation');
          if (type === 'setWatchpoint') {
            if (!source.snapshot().blackboard) return failure('INVALID_STATE', 'Runner has no blackboard');
            if (!watchpoints.has(key) && watchpoints.size >= 1000) return failure('INVALID_STATE', 'Watchpoint limit reached');
          }
        }
        let breakpoint: EntryBreakpoint | undefined;
        if (type === 'setBreakpoint' || type === 'removeBreakpoint') {
          if (kind !== 'entry' && kind !== 'resume') return failure('INVALID_COMMAND', 'Expected entry or resume breakpoint kind');
          if (typeof nodeId !== 'string' || !nodeId.trim() || nodeId.length > 1024) return failure('INVALID_COMMAND', 'Expected a node ID of 1–1024 characters');
          if (type === 'setBreakpoint') {
            if (!breakpoints.has(breakpointKey(nodeId, kind)) && breakpoints.size >= 1000) return failure('INVALID_STATE', 'Breakpoint limit reached');
            if (('inputPath' in fields) !== ('equals' in fields)) return failure('INVALID_COMMAND', 'Conditional breakpoints require inputPath and equals');
            let path: string[] | undefined;
            if ('inputPath' in fields) {
              if (!Array.isArray(inputPath) || inputPath.length > 32 || Reflect.ownKeys(inputPath).length !== inputPath.length + 1) return failure('INVALID_COMMAND', 'Expected a path of at most 32 string keys');
              path = [];
              for (let i = 0; i < inputPath.length; i++) {
                const property = Object.getOwnPropertyDescriptor(inputPath, String(i));
                if (!property || !('value' in property) || typeof property.value !== 'string' || property.value.length > 256) return failure('INVALID_COMMAND', 'Expected path data keys of at most 256 characters');
                path.push(property.value);
              }
              if (equals !== null && !['string', 'boolean', 'number'].includes(typeof equals) ||
                  typeof equals === 'number' && !Number.isFinite(equals) || typeof equals === 'string' && equals.length > 2048) {
                return failure('INVALID_COMMAND', 'Expected a finite JSON scalar comparison value');
              }
            }
            breakpoint = Object.freeze({ nodeId, kind, ...(path ? { inputPath: Object.freeze(path), equals } : {}) });
          }
        }
        if (type === 'cancel' && reason !== undefined && typeof reason !== 'string') return failure('INVALID_COMMAND', 'Expected a string reason');
        if (type === 'select' && activationId !== null && (!Number.isSafeInteger(activationId) || activationId < 1)) {
          return failure('INVALID_COMMAND', 'Expected a positive activation ID or null');
        }
        const state = source.snapshot();
        let stepTarget: number | undefined;
        if (type === 'stepOver' || type === 'stepOut') {
          if (!state.paused) return failure('INVALID_STATE', 'Pause before step-over/out');
          const frame = state.frames.find(frame => frame.activationId === selected) ?? state.frames.filter(frame => frame.onTraversal).at(-1);
          if (!frame) return failure('INVALID_STATE', 'No live activation; use stepInto to initialize execution');
          stepTarget = type === 'stepOver' ? frame.activationId : frame.parentActivationId ?? undefined;
          if (stepTarget === undefined) return failure('INVALID_STATE', 'The root activation has no parent to step out of');
        }
        if (type === 'select') {
          if (activationId !== null && !state.frames.some(frame => frame.activationId === activationId)) return failure('INVALID_STATE', 'Activation is not live');
        } else if (!['setBreakpoint', 'removeBreakpoint', 'setWatchpoint', 'removeWatchpoint'].includes(type)) {
          if (!['idle', 'RUNNING'].includes(state.status)) return failure('INVALID_STATE', 'Runner is terminal');
          if (type === 'tick' && state.paused) return failure('INVALID_STATE', 'Continue before advancing a logical tick; use stepInto while paused');
        }
        drive(() => {
          if (['continue', 'stepInto', 'tick', 'cancel', 'stepOver', 'stepOut'].includes(type)) { stepResult = null; watchpointHit = null; }
          switch (type) {
            case 'pause': source.pause(); break;
            case 'continue': source.continue(); break;
            case 'stepInto': breakpointHit = null; source.step(); break;
            case 'stepOver': case 'stepOut': advance(type, stepTarget!); break;
            case 'tick': source.tick(); break;
            case 'cancel': source.cancel(reason); break;
            case 'select': selected = activationId; break;
            case 'setBreakpoint': breakpoints.set(breakpointKey(nodeId, kind), breakpoint!); break;
            case 'removeBreakpoint': breakpoints.delete(breakpointKey(nodeId, kind)); break;
            case 'setWatchpoint':
              if (!unsubscribeWrites) unsubscribeWrites = source.observeBlackboard(change => {
                const watchpoint = watchpoints.get(change.key);
                if (!watchpoint || watchpoint.operation !== 'any' && watchpoint.operation !== change.type) return;
                const status = source.snapshot().status;
                if (status !== 'idle' && status !== 'RUNNING') return;
                watchpointHit = Object.freeze({ ...change });
                source.pause();
              });
              watchpoints.set(key, Object.freeze({ key, operation }));
              break;
            case 'removeWatchpoint':
              watchpoints.delete(key);
              if (!watchpoints.size) { unsubscribeWrites?.(); unsubscribeWrites = undefined; }
              break;
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
    dispose() { disposed = true; listeners.clear(); unsubscribeEvents(); unsubscribeEntries(); unsubscribeResumes(); unsubscribeWrites?.(); }
  });
}
