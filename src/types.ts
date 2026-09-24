import type { waits } from './waits.js';

/** Application-owned values are intentionally unconstrained at the runtime boundary. */
export type Value = any;
export type Reactive = boolean | 'inherited';
export type BehaviorStatus = 'SUCCESS' | 'FAILURE' | 'RUNNING';
export type RunnerStatus = BehaviorStatus | 'idle' | 'cancelled' | 'errored';
export interface Completion { status: 'SUCCESS' | 'FAILURE'; output?: Value }
export interface WaitOptions { resume?: string; resolve?: string; reject?: string }
export type WaitKind = 'promise' | 'timer' | 'event' | 'poll' | 'any' | 'all';
export type WaitDescriptor = { status: 'RUNNING'; resolve?: string; reject?: string } & (
  { kind: 'promise'; promise: PromiseLike<Value> } |
  { kind: 'timer'; ms: number; value?: Value } |
  { kind: 'event'; subscribe: (notify: (value?: Value) => void) => () => void } |
  { kind: 'poll'; predicate: () => Value } |
  { kind: 'any' | 'all'; children: readonly WaitDescriptor[] }
);
export type ActionResult = BehaviorStatus | Completion | { status: 'RUNNING'; kind?: undefined } | WaitDescriptor;
export interface ActionContext {
  input: Value;
  local: Record<string, Value>;
  services: Record<string, Value>;
  success(output?: Value): Completion;
  failure(output?: Value): Completion;
  wait: typeof waits;
}
export type ActionHandler = (context: ActionContext) => ActionResult;
export type ResumeHandler = (context: ActionContext, value: Value) => ActionResult;
interface ActionBase {
  id: string;
  reactive?: Reactive;
  resume?: Readonly<Record<string, ResumeHandler>>;
  cancel?: (context: ActionContext, reason: string) => void;
}
export type ActionOptions = ActionBase & (
  { enter: ActionHandler; tick?: never } | { tick: ActionHandler; enter?: never }
);
export type ActionDefinition = Readonly<ActionOptions & {
  type: 'action'; reactive: Reactive; resume: Readonly<Record<string, ResumeHandler>>;
}>;
export interface Scope { input: Value; vars: Readonly<Record<string, Value>>; last: Value }
export interface SequenceStep {
  node: NodeDefinition;
  input?: (scope: Scope) => Value;
  save?: string;
}
export interface SequenceOptions {
  id: string;
  steps: readonly SequenceStep[];
  output?: (scope: Scope) => Value;
  reactive?: Reactive;
}
export interface SequenceDefinition {
  readonly type: 'sequence';
  readonly id: string;
  readonly steps: readonly Readonly<SequenceStep>[];
  readonly output: (scope: Scope) => Value;
  readonly reactive: Reactive;
}
export type ConditionContext = Pick<ActionContext, 'input' | 'local' | 'services'>;
export interface ConditionOptions {
  id: string;
  test: (context: ConditionContext) => boolean;
  reactive?: Reactive;
}
export interface ConditionDefinition {
  readonly type: 'condition';
  readonly id: string;
  readonly test: (context: ConditionContext) => boolean;
  readonly reactive: Reactive;
}
/** Selectors use the same input/save bindings as sequences. */
export type SelectorStep = SequenceStep;
export type SelectorOptions = SequenceOptions;
export interface SelectorDefinition extends Omit<SequenceDefinition, 'type'> {
  readonly type: 'selector';
}
export type NodeDefinition = ActionDefinition | ConditionDefinition | SequenceDefinition | SelectorDefinition;
/** Timer handles are opaque and owned by the injected host clock. */
export interface Clock {
  setTimeout(callback: () => void, ms: number): Value;
  clearTimeout(handle: Value): void;
}
export interface RunnerOptions {
  input?: Value;
  services?: Record<string, Value>;
  maxStepsPerTick?: number;
  clock?: Clock;
}
export type FramePhase = 'enter' | 'running' | 'waiting' | 'child' | 'childResult';
export interface FrameSnapshot {
  readonly nodeId: string;
  readonly activationId: number;
  readonly phase: FramePhase;
  readonly input: Value;
  readonly local: Readonly<Record<string, Value>>;
  readonly vars: Readonly<Record<string, Value>>;
  readonly childIndex: number;
  readonly reactive: Reactive;
  readonly effectiveReactive: boolean;
  readonly onTraversal: boolean;
  readonly waitingOn?: WaitKind;
}
export interface RunnerSnapshot {
  readonly status: RunnerStatus;
  readonly output: Value;
  readonly error: unknown;
  readonly paused: boolean;
  readonly tick: number;
  readonly transitions: number;
  readonly queuedResumes: number;
  readonly frames: readonly FrameSnapshot[];
}
export interface Runner {
  tick(): RunnerSnapshot;
  step(): RunnerSnapshot;
  pause(): void;
  continue(): void;
  snapshot(): RunnerSnapshot;
  cancel(reason?: string): RunnerSnapshot;
}
