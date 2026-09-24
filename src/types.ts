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
export interface BlackboardSnapshot {
  readonly revision: number;
  readonly values: Readonly<Record<string, Value>>;
}
export interface BlackboardChange {
  readonly revision: number;
  readonly type: 'set' | 'delete';
  readonly key: string;
  readonly hadValue: boolean;
  readonly previous: Value;
  readonly value: Value;
}
export type BlackboardListener = (change: BlackboardChange) => void;
/** Caller-owned state; sharing a board is explicit, and runners never dispose it. */
export interface Blackboard {
  readonly revision: number;
  has(key: string): boolean;
  get(key: string): Value;
  set(key: string, value: Value): void;
  delete(key: string): boolean;
  snapshot(): BlackboardSnapshot;
  subscribe(listener: BlackboardListener): () => void;
}
export interface ActionContext {
  input: Value;
  local: Record<string, Value>;
  services: Record<string, Value>;
  blackboard?: Blackboard;
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
export type ConditionContext = Pick<ActionContext, 'input' | 'local' | 'services' | 'blackboard'>;
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
export type DecoratorKind = 'inverter' | 'forceSuccess' | 'forceFailure';
export interface DecoratorOptions {
  id: string;
  child: NodeDefinition;
  reactive?: Reactive;
}
export interface DecoratorDefinition {
  readonly type: DecoratorKind;
  readonly id: string;
  readonly child: NodeDefinition;
  readonly reactive: Reactive;
}
export interface RetryOptions extends DecoratorOptions {
  /** Total attempts, including the first; positive safe integer or Infinity. */
  attempts: number;
}
export interface RepeatOptions extends DecoratorOptions {
  /** Required successful iterations; nonnegative safe integer or Infinity. */
  times: number;
}
export interface RetryDefinition extends Omit<DecoratorDefinition, 'type'> {
  readonly type: 'retry';
  readonly attempts: number;
}
export interface RepeatDefinition extends Omit<DecoratorDefinition, 'type'> {
  readonly type: 'repeat';
  readonly times: number;
}
export type TimedDecoratorKind = 'delay' | 'timeout' | 'cooldown';
export interface TimedDecoratorOptions extends DecoratorOptions {
  ms: number;
}
export interface TimedDecoratorDefinition extends Omit<DecoratorDefinition, 'type'> {
  readonly type: TimedDecoratorKind;
  readonly ms: number;
}
export interface SubtreeOptions extends DecoratorOptions {
  input?: (scope: Scope) => Value;
  /** Runs for success and failure; maps output without changing status. */
  output?: (scope: Scope, result: Readonly<Completion>) => Value;
}
export interface SubtreeDefinition extends Omit<DecoratorDefinition, 'type'> {
  readonly type: 'subtree';
  readonly input?: (scope: Scope) => Value;
  readonly output: (scope: Scope, result: Readonly<Completion>) => Value;
}
export interface ParallelStep {
  node: NodeDefinition;
  input?: (scope: Scope) => Value;
  /** Parallel branches expose outputs through the reducer, never shared save bindings. */
  save?: never;
}
export type ParallelResults = readonly (Readonly<Completion> | undefined)[];
export interface ParallelOptions {
  id: string;
  steps: readonly ParallelStep[];
  successThreshold: number;
  failureThreshold: number;
  reactive?: Reactive;
  output?: (results: ParallelResults, status: Completion['status']) => Value;
}
export interface ParallelDefinition {
  readonly type: 'parallel';
  readonly id: string;
  readonly steps: readonly Readonly<ParallelStep>[];
  readonly successThreshold: number;
  readonly failureThreshold: number;
  readonly reactive: Reactive;
  readonly output: (results: ParallelResults, status: Completion['status']) => Value;
}
export type NodeDefinition = ActionDefinition | ConditionDefinition | SequenceDefinition | SelectorDefinition | DecoratorDefinition | RetryDefinition | RepeatDefinition | TimedDecoratorDefinition | SubtreeDefinition | ParallelDefinition;
/** Timer handles are opaque and owned by the injected host clock. */
export interface Clock {
  setTimeout(callback: () => void, ms: number): Value;
  clearTimeout(handle: Value): void;
}
export interface RunnerOptions {
  input?: Value;
  services?: Record<string, Value>;
  blackboard?: Blackboard;
  maxStepsPerTick?: number;
  clock?: Clock;
}
export type FramePhase = 'enter' | 'running' | 'waiting' | 'child' | 'childResult';
export interface FrameSnapshot {
  /** Finished child attempts for retry/repeat frames, including failures. */
  readonly completedIterations?: number;
  readonly parallelResults?: ParallelResults;
  readonly nodeId: string;
  readonly activationId: number;
  readonly parentActivationId: number | null;
  readonly parentChildIndex: number | null;
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
  readonly blackboard?: BlackboardSnapshot;
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
