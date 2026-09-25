import { createRunner, createRunnerScheduler, createDebugger, RUNNING } from '../../dist/index.js';
import { mountTreeView } from './tree-view.js';
import { createWorld, advanceWorld, createMission } from './game.js';

const byId = id => document.getElementById(id);
const signal = byId('signal');
const controls = document.querySelectorAll('button, input, select');
for (const control of controls) control.disabled = true;
byId('status').textContent = 'Loading mission...';
const missionFormat = new URL(location.href).searchParams.get('format') ?? 'json';
const formatControl = byId('mission-format');
formatControl.value = missionFormat;
formatControl.onchange = () => {
  const url = new URL(location.href);
  url.searchParams.set('format', formatControl.value);
  location.assign(url);
};
let missionText;
let runner, scheduler, debug, lastSignature = '';
let previousTime = performance.now();
function log(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  byId('history').prepend(item);
  while (byId('history').children.length > 100) byId('history').lastChild.remove();
}
let world, tree, treeView, selectedNode;
const crystalElements = [];
function mountWorld() {
  byId('crystals').replaceChildren();
  crystalElements.length = 0;
  for (const crystal of world.crystals) {
    const marker = document.createElement('span');
    marker.className = 'crystal'; marker.textContent = crystal.id;
    marker.style.left = `${crystal.x}%`; marker.style.top = `${crystal.y}%`;
    byId('crystals').append(marker); crystalElements.push(marker);
  }
}
byId('tree-mode').onchange = event => treeView.setMode(event.target.value);
function render() {
  const state = runner.snapshot();
  const active = state.status === 'idle' || state.status === RUNNING;
  byId('start').disabled = state.status !== 'idle' || state.paused;
  byId('name').disabled = state.status !== 'idle';
  byId('status').textContent = `${state.status}${state.paused ? ' Â· paused' : ''}`;
  byId('pause').disabled = state.status !== RUNNING || state.paused;
  byId('continue').disabled = !active || !state.paused;
  byId('step').disabled = !active;
  byId('cancel').disabled = !active;
  signal.disabled = state.paused || state.frames.at(-1)?.phase !== 'running' || !state.frames.at(-1)?.nodeId.endsWith('-scan');
  treeView.update(state);
  byId('agent').style.left = `${world.x}%`;
  byId('agent').style.top = `${world.y}%`;
  world.crystals.forEach((crystal, index) => { crystalElements[index].hidden = !crystal.remaining; });
  byId('game-status').textContent = `${world.phase} Â· Cargo ${world.cargo} Â· Delivered ${world.delivered} / ${world.crystals.length}`;
  byId('node-inspection').textContent = JSON.stringify(
    state.frames.find(frame => frame.nodeId === selectedNode) ?? {
      nodeId: selectedNode, status: selectedNode === tree.id ? state.status : 'inactive',
      ...(selectedNode === tree.id ? { output: state.output } : {}),
      note: 'Only live activation data is retained in this example.'
    }, null, 2);
  byId('resources').textContent = `Simulation time: ${world.time.toFixed(1)}s`;
  byId('inspection').textContent = JSON.stringify(state, (key, value) => value instanceof Error ? value.message : value, 2);
  const signature = JSON.stringify([state.status, state.paused, state.frames.map(f => [f.nodeId, f.phase]), state.queuedResumes]);
  if (signature !== lastSignature) { log(`${state.status}${state.paused ? ' (paused)' : ''} Â· ${state.frames.at(-1)?.nodeId ?? 'no active node'} Â· queued: ${state.queuedResumes}`); lastSignature = signature; }
}
function reset() {
  scheduler?.dispose();
  debug?.dispose();
  runner?.cancel('reset');
  previousTime = performance.now();
  treeView?.dispose();
  world = createWorld();
  const mission = createMission(world, missionText, log, missionFormat);
  tree = mission.tree; selectedNode = tree.id;
  treeView = mountTreeView({ target: byId('tree'), tree, labels: mission.labels,
    onSelect(id) { selectedNode = id; render(); } });
  treeView.setMode(byId('tree-mode').value);
  mountWorld();
  attachRunner();
  lastSignature = ''; log('Reset â€” ready to start');
  render();
}
function attachRunner() {
  debug?.dispose();
  debug = createDebugger(createRunner(tree, { input: { name: byId('name').value } }), {
    onListenerError: error => log(`Debugger view failed: ${error.message}`)
  });
  runner = debug.runner;
  debug.subscribe(render);
}
function execute(type) {
  const result = debug.command({ type });
  if (!result.ok) log(`${result.code}: ${result.message}`);
}
function startScheduler() {
  scheduler?.dispose();
  scheduler = createRunnerScheduler(runner, {
    intervalMs: 100,
    beforeTick() {
      const now = performance.now();
      advanceWorld(world, Math.min((now - previousTime) / 1000, 0.2));
      previousTime = now;
    },
    onError(error) { log(`Scheduler failed: ${error.message}`); render(); }
  });
  scheduler.start();
}
byId('reset').onclick = reset;
byId('start').onclick = () => {
  if (runner.snapshot().status !== 'idle') return;
  attachRunner();
  previousTime = performance.now();
  execute('tick'); log('start');
  startScheduler();
};
// A repeated RUNNING action gets one simulation frame before its next evaluation.
function stepExecution() {
  if (runner.snapshot().frames.at(-1)?.phase === 'running') advanceWorld(world, 0.1);
  execute('stepInto');
}
signal.onclick = () => { if (!signal.disabled) world.radarPing = true; };
for (const command of ['pause', 'continue', 'step', 'cancel']) {
  byId(command).onclick = () => {
    if (command === 'step' && runner.snapshot().status === 'idle') {
      attachRunner();
    }
    previousTime = performance.now();
    if (command === 'step') stepExecution();
    else execute(command);
    if (command === 'continue') startScheduler();
    log(command); render();
  };
}
try {
  if (!['json', 'yaml'].includes(missionFormat)) throw new Error(`Unsupported mission format: ${missionFormat}`);
  const response = await fetch(new URL(`./mission.${missionFormat}`, import.meta.url));
  if (!response.ok) throw new Error(`Mission request failed (${response.status})`);
  missionText = await response.text();
  log(`Loaded mission.${missionFormat}`);
  reset();
  // Enable controls that are not managed by render(), then apply execution state.
  byId('reset').disabled = false;
  byId('tree-mode').disabled = false;
  formatControl.disabled = false;
  addEventListener('pagehide', () => { scheduler?.dispose(); debug.dispose(); runner.cancel('page closed'); treeView.dispose(); }, { once: true });
} catch (error) {
  for (const control of controls) control.disabled = true;
  formatControl.disabled = false;
  byId('status').textContent = 'Mission could not be loaded';
  byId('game-status').textContent = error.message;
  log(`Mission load failed: ${error.message}`);
}
