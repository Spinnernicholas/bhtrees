import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createExampleServer } from './serve.js';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/check-browser.js <Chrome-or-Edge executable>');
const server = createExampleServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'bhtrees-browser-'));
try {
  const child = spawn(executable, ['--headless', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=60000',
    `http://127.0.0.1:${server.address().port}/examples/browser/smoke.html`], { windowsHide: true });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    if (!output.includes('data-result="pass"')) throw new Error(`Browser smoke failed:\n${output}\n${errors.slice(-2000)}`);
    console.log('Browser smoke passed: connected blocks, full agent mission, controls and cleanup.');
  } finally { clearTimeout(timer); }
} finally {
  await new Promise(resolve => server.close(resolve));
  const absolute = resolve(profile);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('bhtrees-browser-')) {
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
