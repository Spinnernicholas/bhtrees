import { loadConfiguredTree } from './config-loader.js';
import type { ConfigFileContent, ConfiguredTree, ConfiguredTreeOptions, ConfiguredRunnerOptions } from './config-loader.js';
import { createExtensionLoader } from './extensions.js';
import type { ExtensionLoaderOptions } from './extensions.js';
import { createRunnerScheduler } from './scheduler.js';
import type { RunnerScheduler, RunnerSchedulerOptions } from './scheduler.js';
import type { Clock, Runner } from './types.js';

export interface AdventureLandHost {
  /** Handles canonical URLs, including host-owned script/document schemes. */
  readDocument(uri: string): ConfigFileContent | Promise<ConfigFileContent>;
  importModule?: ExtensionLoaderOptions['importModule'];
  services?: ConfiguredRunnerOptions['services'];
  clock?: Clock;
}
export interface AdventureLandSessionOptions extends Omit<ConfiguredTreeOptions, 'readConfig'> {
  host: AdventureLandHost;
  extensions?: Omit<ExtensionLoaderOptions, 'importModule'>;
  runner?: Omit<ConfiguredRunnerOptions, 'clock' | 'services'>;
  scheduler?: Omit<RunnerSchedulerOptions, 'clock'>;
  /** Cancels loading; after loading, call dispose explicitly. */
  signal?: AbortSignal;
}
export interface AdventureLandSession {
  readonly configured: ConfiguredTree;
  readonly runner: Runner;
  readonly scheduler: RunnerScheduler;
  /** Start driving asynchronously. Does not reset a completed runner. */
  start(): void;
  /** Stop timers and cancel the runner immediately, then release extensions. */
  dispose(): Promise<void>;
}

/** Host owns game globals and code-slot loading; no implicit eval or global mutation. */
export async function loadAdventureLandSession(path: string | URL, options: AdventureLandSessionOptions): Promise<AdventureLandSession> {
  const { host, extensions, runner: runnerOptions, scheduler: schedulerOptions, signal, ...treeOptions } = options;
  const baseURI = new URL(String(path), options.baseURI).href;
  signal?.throwIfAborted();
  const file = await host.readDocument(baseURI);
  signal?.throwIfAborted();
  const configured = await loadConfiguredTree(file.text, {
    ...treeOptions, codec: options.codec ?? file.codec, baseURI,
    readConfig: uri => host.readDocument(uri),
    extensionLoader: options.extensionLoader ?? createExtensionLoader({ ...extensions,
      importModule: host.importModule ? uri => host.importModule!(uri) : undefined })
  });
  let runner: Runner | undefined, scheduler: RunnerScheduler | undefined;
  try {
    signal?.throwIfAborted();
    runner = configured.createRunner({ ...runnerOptions, services: host.services, clock: host.clock });
    scheduler = createRunnerScheduler(runner, { ...schedulerOptions, clock: host.clock });
  } catch (error) {
    try { await configured.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Session setup and cleanup failed'); }
    throw error;
  }
  const ownedRunner = runner, ownedScheduler = scheduler;
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    configured, runner: ownedRunner, scheduler: ownedScheduler,
    start() { ownedScheduler.start(); },
    dispose() {
      if (!disposal) {
        // Install the promise first so cancellation hooks may call dispose reentrantly.
        let finish!: () => void, fail!: (error: unknown) => void;
        disposal = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        const errors: unknown[] = [];
        try { ownedScheduler.dispose(); } catch (error) { errors.push(error); }
        try {
          const before = ownedRunner.snapshot().error;
          const after = ownedRunner.cancel('Adventure Land session disposed');
          if (after.error !== undefined && after.error !== before) errors.push(after.error);
        } catch (error) { errors.push(error); }
        void configured.dispose().catch(error => { errors.push(error); }).then(() => {
          if (errors.length) fail(new AggregateError(errors, 'Session disposal failed'));
          else finish();
        });
      }
      return disposal;
    }
  });
}
