import type { DebugCommand, DebugEventSummary } from './debugger.js';
import type { DebugValue } from './debug-wire.js';

export interface RemoteDebugState {
  events: readonly DebugEventSummary[];
  droppedEvents: number;
  version: 1;
  capabilities: readonly DebugCommand['type'][];
  definition: { root: string; nodes: readonly { id: string; type: string; children: readonly string[] }[] };
  snapshot: DebugValue;
}
export interface RemoteDebuggerOptions {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}
/** Stateless HTTP transport: each read resynchronizes with the current runtime. */
export function createRemoteDebugger(options: RemoteDebuggerOptions) {
  const base = new URL(options.url);
  if (!['http:', 'https:'].includes(base.protocol)) throw new TypeError('Expected HTTP(S) debugger URL');
  base.hash = ''; base.search = ''; base.pathname = '/';
  const request = options.fetch ?? globalThis.fetch;
  async function send(path: string, command?: DebugCommand): Promise<unknown> {
    const response = await request(new URL(path, base), {
      method: command ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${options.token}`, ...(command ? { 'Content-Type': 'application/json' } : {}) },
      body: command ? JSON.stringify(command) : undefined,
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Debugger request failed (${response.status})`);
    const data = await response.json();
    if (data?.version !== 1) throw new Error('Unsupported debugger protocol version');
    return data;
  }
  return Object.freeze({
    read: () => send('/api/state') as Promise<RemoteDebugState>,
    command: (command: DebugCommand) => send('/api/command', command) as Promise<{ version: 1; result: DebugValue }>
  });
}
