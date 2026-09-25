/// <reference types="node" />
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DebuggerClient, DebugCommand } from './debugger.js';
import type { NodeDefinition } from './types.js';
import { inspectDebugValue } from './debug-wire.js';
import { debugPage, debugView } from './debug-page.js';

export interface DebuggerServerOptions {
  client: DebuggerClient;
  tree: NodeDefinition;
  /** Binds IPv4 loopback only. Defaults to an available port. */
  port?: number;
}
export interface DebuggerServer {
  /** Browser URL with a per-server access token in its fragment. Treat as a secret. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startDebuggerServer({ client, tree, port = 0 }: DebuggerServerOptions): Promise<DebuggerServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid debugger port');
  const nodes: { id: string; type: string; children: string[] }[] = [];
  const seen = new Set<NodeDefinition>(), ids = new Map<string, NodeDefinition>(), queue = [tree];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]; if (seen.has(node)) continue;
    if (ids.has(node.id) && ids.get(node.id) !== node) throw new Error('Conflicting tree node IDs');
    if (nodes.length >= 10000) throw new Error('Debugger tree exceeds 10000 definitions');
    seen.add(node); ids.set(node.id, node);
    const children = 'steps' in node ? node.steps.map(step => step.node) : 'child' in node ? [node.child] : [];
    if (queue.length + children.length > 50000) throw new Error('Debugger tree exceeds edge limit');
    nodes.push({ id: node.id, type: node.type, children: children.map(child => child.id) }); queue.push(...children);
  }
  const browserClient = await readFile(new URL('./debug-remote.js', import.meta.url), 'utf8');
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    try {
      if (`http://${request.headers.host}` !== origin || (request.headers.origin && request.headers.origin !== origin)) {
        send(403, { error: 'Origin denied' }); return;
      }
      const path = new URL(request.url ?? '/', origin).pathname;
      if (request.method === 'GET' && ['/', '/view.js', '/client.js'].includes(path)) {
        response.writeHead(200, { 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
        response.end(path === '/' ? debugPage : path === '/view.js' ? debugView : browserClient); return;
      }
      const auth = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { send(401, { error: 'Unauthorized' }); return; }
      if (path === '/api/state' && request.method === 'GET') {
        const state = client.refresh();
        // Keep control metadata ahead of potentially large application values.
        const snapshot = { version: state.version, revision: state.revision, selectedActivationId: state.selectedActivationId,
          runner: { status: state.runner.status, paused: state.runner.paused, tick: state.runner.tick,
            transitions: state.runner.transitions, queuedResumes: state.runner.queuedResumes,
            frames: state.runner.frames, output: state.runner.output, error: state.runner.error, blackboard: state.runner.blackboard } };
        send(200, { version: 1, capabilities: client.capabilities, definition: { root: tree.id, nodes },
          snapshot: inspectDebugValue(snapshot), events: state.events, droppedEvents: state.droppedEvents,
          breakpoints: state.breakpoints, breakpointHit: state.breakpointHit, stepResult: state.stepResult }); return;
      }
      if (path === '/api/command' && request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { error: 'Expected JSON' }); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 4096) { send(413, { error: 'Command too large' }); return; }
          chunks.push(Buffer.from(chunk));
        }
        let command: DebugCommand;
        try { command = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { error: 'Invalid JSON' }); return; }
        send(200, { version: 1, result: inspectDebugValue(client.command(command)) }); return;
      }
      send(404, { error: 'Not found' });
    } catch { if (!response.headersSent) send(500, { error: 'Debugger request failed' }); else response.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Debugger did not bind TCP');
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return Object.freeze({ url: `${origin}/#token=${token}`, close() {
    if (!closing) closing = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    });
    return closing;
  } });
}
