import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { action, createRunner, createDebugger } from '../dist/index.js';
import { startDebuggerServer } from '../dist/node.js';

const executable = process.argv[2];
if (!executable) throw Error('Usage: node scripts/check-remote-browser.js <Chrome executable>');
const tree = action({ id: 'remote-smoke-node', tick: () => 'RUNNING' });
const debug = createDebugger(createRunner(tree));
debug.runner.tick();
const server = await startDebuggerServer({ client: debug, tree });
const profile = await mkdtemp(join(tmpdir(), 'bhtrees-remote-'));
try {
  const child = spawn(executable, ['--headless', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=4000', server.url], { windowsHide: true });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    if (!output.includes('data-connected="true"') || !output.includes('remote-smoke-node') || !output.includes('data-command="stepInto"')) {
      throw Error(`Remote browser smoke failed:\n${output}\n${errors.slice(-1500)}`);
    }
    console.log('Remote browser smoke passed: authenticated connection, tree, live state and controls.');
  } finally { clearTimeout(timer); }
} finally {
  await server.close(); debug.runner.cancel(); debug.dispose();
  const target = resolve(profile);
  if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('bhtrees-remote-')) {
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
